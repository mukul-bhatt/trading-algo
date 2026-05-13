/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/holdingsMonitor.js  –  Real-Time Holdings Operator-Exit Spike Detector
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PURPOSE:
 * ─────────
 * Detects when an operator is exiting a T2T / penny stock position by
 * monitoring two concurrent signals via the Kite WebSocket (full mode):
 *
 *   SIGNAL 1 – Volume Spike
 *     Compares today's actual traded volume (time-adjusted) against the
 *     N-day MEDIAN daily volume.  Using median (not average) ensures that
 *     the day the operator entered (which had high volume) does not inflate
 *     the baseline and mask the exit spike.
 *
 *     Expected volume at time T = (medianDailyVolume / 375 min) × elapsed_min
 *     Alert if: actualVolume >= VOLUME_SPIKE_MULTIPLIER × expectedVolume
 *
 *   SIGNAL 2 – Order-Book Depth Ratio Spike
 *     In an upper-circuit stock the buy side is huge, sell side is near zero.
 *     The moment the operator starts placing sell orders, the sell-side depth
 *     jumps BEFORE the volume even shows up — giving us an earlier warning.
 *
 *     Alert if: (sell_quantity / buy_quantity) >= DEPTH_RATIO_ALERT_THRESHOLD
 *
 * BOTH signals must fire simultaneously to trigger an alert / auto-sell.
 * This minimises false positives.
 *
 * AUTO-SELL:
 * ──────────
 *   AUTO_SELL_ON_SPIKE=true  → places a CNC SELL MARKET order immediately
 *   AUTO_SELL_ON_SPIKE=false → logs a loud warning only (safe for testing)
 *
 * COOLDOWN:
 * ─────────
 * Once an alert fires for a stock, it won't fire again for SPIKE_COOLDOWN_SECONDS
 * to prevent alert storms and duplicate orders.
 *
 * ENV VARIABLES (add to .env):
 * ──────────────────────────────
 *   AUTO_SELL_ON_SPIKE=false          false=log only | true=auto-sell
 *   VOLUME_LOOKBACK_DAYS=7            N days for median volume baseline
 *   VOLUME_SPIKE_MULTIPLIER=3.0       alert if actual >= N × expected
 *   DEPTH_RATIO_ALERT_THRESHOLD=0.3   alert if sell_qty/buy_qty >= this
 *   SPIKE_COOLDOWN_SECONDS=60         min seconds between alerts per stock
 *   HOLDINGS_REFRESH_MS=300000        how often to re-fetch holdings (ms)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger          = require('./logger');
const { getKiteClient }  = require('./login');
const { retry, formatCurrency, isDryRun, sleep } = require('./utils');
const { startTicker } = require('./websocket');

// ── Config ────────────────────────────────────────────────────────────────────

const AUTO_SELL          = process.env.AUTO_SELL_ON_SPIKE === 'true';
const LOOKBACK_DAYS      = parseInt(process.env.VOLUME_LOOKBACK_DAYS        || '7',   10);
const VOL_MULTIPLIER     = parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER   || '3.0');
const DEPTH_THRESHOLD    = parseFloat(process.env.DEPTH_RATIO_ALERT_THRESHOLD|| '0.3');
const COOLDOWN_SEC       = parseInt(process.env.SPIKE_COOLDOWN_SECONDS      || '60',  10);
const REFRESH_MS         = parseInt(process.env.HOLDINGS_REFRESH_MS         || '300000', 10);

// ── Stop-loss config ──────────────────────────────────────────────────────────
// Sells the holding if price drops more than STOP_LOSS_PCT % below the
// PREVIOUS DAY's closing price (= yesterday's upper circuit price for T2T stocks).
//
// WHY PREVIOUS CLOSE, NOT BUY PRICE?
//   For penny stocks in upper circuit, yesterday's close IS the upper circuit.
//   If today's price has fallen 3% below that, the upper circuit scenario that
//   justified buying has broken down — exit immediately regardless of your P&L.
//
// tick.ohlc.close = previous day's closing price (always available in full mode)
const STOP_LOSS_ENABLED  = process.env.STOP_LOSS_ENABLED === 'true';
const STOP_LOSS_PCT      = parseFloat(process.env.STOP_LOSS_PCT || '3.0');

// NSE trades 375 minutes per day (9:15 AM – 3:30 PM)
const TRADING_MINUTES = 375;

// ── In-memory state ───────────────────────────────────────────────────────────

// Map<instrumentToken, holdingInfo>
const holdingsMap = new Map();

// Map<instrumentToken, { medianVolume: number|null }>
const baselines = new Map();

// Map<instrumentToken, lastAlertTimestampMs>
const lastAlertAt = new Map();

// Set<instrumentToken> – stocks already sold today (prevents duplicate orders)
const soldToday = new Set();

// Reference to kite client – set once on startup
let kiteClient = null;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the median of a numeric array.
 * Using median (not mean) makes the baseline robust to outlier days
 * (e.g. the day the operator entered and volume was unusually high).
 */
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Minutes elapsed since NSE market open (9:15 AM IST).
 * Returns at least 1 to avoid division by zero.
 */
function minutesSinceOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const elapsed = ist.getHours() * 60 + ist.getMinutes() - (9 * 60 + 15);
  return Math.max(1, elapsed);
}

// ── Historical data / baseline ────────────────────────────────────────────────

/**
 * Fetches the last LOOKBACK_DAYS days of daily OHLCV data from Kite and
 * returns the MEDIAN volume across those days.
 *
 * We request an extra buffer of calendar days to account for weekends and
 * market holidays — Kite simply returns no candle for non-trading days.
 */
async function fetchMedianVolume(kite, instrumentToken, tradingsymbol) {
  try {
    const to   = new Date();
    const from = new Date();
    // Extra buffer: LOOKBACK_DAYS × 2 + 7 to cover weekends + holidays
    from.setDate(from.getDate() - (LOOKBACK_DAYS * 2 + 7));

    const fromStr = from.toISOString().slice(0, 10);
    const toStr   = to.toISOString().slice(0, 10);

    const candles = await retry(
      () => kite.getHistoricalData(instrumentToken, 'day', fromStr, toStr),
      { maxAttempts: 3, label: `historicalData:${tradingsymbol}` }
    );

    if (!candles || candles.length === 0) {
      logger.warn(`⚠️  No historical data for ${tradingsymbol} – volume signal disabled for this stock`);
      return null;
    }

    // Take only the last LOOKBACK_DAYS completed trading days (exclude today's
    // partial candle which is the last entry if market is open)
    const completedDays = candles.slice(-(LOOKBACK_DAYS + 1), -1);
    const volumes = completedDays.map((c) => c.volume).filter((v) => v > 0);

    if (volumes.length === 0) {
      logger.warn(`⚠️  All-zero volumes for ${tradingsymbol} – volume signal disabled`);
      return null;
    }

    const med = median(volumes);
    logger.info(
      `   📊 ${tradingsymbol.padEnd(15)} ${volumes.length}-day median vol: ` +
      `${med.toLocaleString('en-IN')} shares`
    );
    return med;

  } catch (err) {
    logger.warn(`⚠️  Could not fetch history for ${tradingsymbol}: ${err.message}`);
    return null;
  }
}

// ── Holdings loader ───────────────────────────────────────────────────────────

/**
 * Fetches current holdings from Kite and populates holdingsMap.
 * For any new holding not yet in baselines, fetches the median volume baseline.
 */
async function loadHoldingsAndBaselines(kite) {
  const raw = await retry(
    () => kite.getHoldings(),
    { maxAttempts: 3, label: 'getHoldings' }
  );

  if (raw.length === 0) {
    logger.info('📁 Holdings: none found.');
    holdingsMap.clear();
    return;
  }

  // Build updated map
  const freshMap = new Map();
  for (const h of raw) {
    freshMap.set(h.instrument_token, {
      tradingsymbol:    h.tradingsymbol,
      exchange:         h.exchange,
      quantity:         h.quantity,
      average_price:    h.average_price,
      instrument_token: h.instrument_token,
    });
  }

  // Fetch baseline only for newly seen holdings
  for (const [token, holding] of freshMap) {
    if (!baselines.has(token)) {
      logger.info(`   🔍 Fetching volume baseline for ${holding.tradingsymbol}…`);
      const medVol = await fetchMedianVolume(kite, token, holding.tradingsymbol);
      baselines.set(token, { medianVolume: medVol });
      await sleep(350); // stay within Kite's rate limits
    }
  }

  // Replace the global map with the fresh one
  holdingsMap.clear();
  for (const [k, v] of freshMap) holdingsMap.set(k, v);

  logger.info(`📁 Holdings loaded: ${holdingsMap.size} stock(s) under watch`);
}

// ── Signal checks ─────────────────────────────────────────────────────────────

/**
 * SIGNAL 1: Time-adjusted volume spike check.
 *
 * At any point in the trading day we know what FRACTION of the day has elapsed.
 * We pro-rate the median daily volume to get the "expected" volume by now.
 * If actual volume is VOL_MULTIPLIER × that expected amount → spike.
 *
 * Example at 10:15 AM (60 min into session):
 *   Expected = medianVolume × (60/375) = 16% of daily volume
 *   If actual is 3× that → alert
 */
function checkVolumeSpike(tick, baseline) {
  if (!baseline.medianVolume) {
    return { fired: false, reason: 'no baseline' };
  }

  const elapsed  = minutesSinceOpen();
  const expected = (baseline.medianVolume / TRADING_MINUTES) * elapsed;
  const actual   = tick.volume_traded || 0;
  const ratio    = actual / Math.max(expected, 1);

  logger.debug(
    `VOL ${tick.instrument_token}: actual=${actual.toLocaleString('en-IN')} ` +
    `expected=${Math.round(expected).toLocaleString('en-IN')} ratio=${ratio.toFixed(2)}x`
  );

  return {
    fired:    ratio >= VOL_MULTIPLIER,
    ratio,
    actual,
    expected: Math.round(expected),
  };
}

/**
 * SIGNAL 2: Order-book depth ratio check.
 *
 * In an upper-circuit stock: buy_quantity >> sell_quantity (ratio near 0).
 * When the operator starts placing large sell orders, sell_quantity rises.
 * Alert if: sell_qty / buy_qty >= DEPTH_THRESHOLD
 *
 * This fires BEFORE volume shows up because orders are placed before they trade.
 */
function checkDepthSpike(tick) {
  const buyQty  = tick.buy_quantity  || 0;
  const sellQty = tick.sell_quantity || 0;

  if (buyQty === 0) {
    return { fired: false, reason: 'buy_qty=0' };
  }

  const ratio = sellQty / buyQty;

  logger.debug(
    `DEPTH ${tick.instrument_token}: buy=${buyQty.toLocaleString('en-IN')} ` +
    `sell=${sellQty.toLocaleString('en-IN')} ratio=${ratio.toFixed(4)}`
  );

  return {
    fired: ratio >= DEPTH_THRESHOLD,
    ratio,
    buyQty,
    sellQty,
  };
}

// ── Auto-sell ─────────────────────────────────────────────────────────────────

async function triggerSell(holding, ltp, reason) {
  const { tradingsymbol, exchange, quantity, instrument_token } = holding;

  // Guard: already sold today
  if (soldToday.has(instrument_token)) {
    logger.warn(`⚠️  ${tradingsymbol}: already sold today – skipping duplicate sell`);
    return;
  }

  // WHY LIMIT, NOT MARKET?
  // ──────────────────────
  // T2T (Trade-to-Trade) category stocks can be illiquid penny stocks.
  // A MARKET order in a thinly-traded stock can suffer extreme slippage —
  // you might sell at a price far below the current LTP if the buy side
  // is thin at that moment.
  //
  // In the upper-circuit scenario we are targeting, the stock is AT or NEAR
  // the upper circuit price and there is a large buy queue.  A LIMIT order
  // at the current LTP (upper circuit price) will match against those buyers
  // immediately and gives you a guaranteed minimum price.
  //
  // If the stock has already come off the circuit and our LIMIT order doesn't
  // fill within the day, it expires as DAY order.  In that case, the user
  // will see the unfilled order in Zerodha and can act manually.
  // This is still safer than a MARKET order that might fill at a terrible price.

  if (isDryRun()) {
    logger.warn(`🧪 [DRY RUN] Would place: SELL ${quantity}x ${tradingsymbol} LIMIT @ ${formatCurrency(ltp)}`);
    logger.warn(`   Reason: ${reason}`);
    return;
  }

  try {
    logger.warn(`🤖 Placing auto-sell: ${quantity}x ${tradingsymbol} LIMIT @ ${formatCurrency(ltp)}…`);

    const orderId = await retry(
      () => kiteClient.placeOrder('regular', {
        tradingsymbol,
        exchange,
        transaction_type: 'SELL',
        quantity,
        product:    'CNC',
        order_type: 'LIMIT',
        price:      ltp,          // sell at current LTP (upper circuit price)
        validity:   'DAY',
        tag:        'SPIKE_SELL',
      }),
      { maxAttempts: 2, delayMs: 500, label: `auto-sell:${tradingsymbol}` }
    );

    soldToday.add(instrument_token);
    logger.warn(`✅ AUTO-SELL ORDER PLACED  ${tradingsymbol}  qty:${quantity}  price:${ltp}  order_id:${orderId}`);

  } catch (err) {
    logger.error(`❌ Auto-sell FAILED for ${tradingsymbol}`, { error: err.message });
  }
}

// ── Alert logger ──────────────────────────────────────────────────────────────

function logAlert(holding, tick, volResult, depthResult) {
  const ts  = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const ltp = formatCurrency(tick.last_price);
  const avg = formatCurrency(holding.average_price);

  logger.warn('');
  logger.warn('╔══════════════════════════════════════════════════════════════╗');
  logger.warn(`║  🚨 OPERATOR EXIT SIGNAL  –  ${holding.tradingsymbol}  @ ${ts} IST`);
  logger.warn('╠══════════════════════════════════════════════════════════════╣');
  logger.warn(`║  📈 VOLUME SPIKE`);
  logger.warn(`║     Actual today  : ${volResult.actual.toLocaleString('en-IN')} shares`);
  logger.warn(`║     Expected by now: ${volResult.expected.toLocaleString('en-IN')} shares`);
  logger.warn(`║     Ratio         : ${volResult.ratio.toFixed(2)}× (threshold: ${VOL_MULTIPLIER}×)`);
  logger.warn('╠══════════════════════════════════════════════════════════════╣');
  logger.warn(`║  📉 DEPTH RATIO SPIKE`);
  logger.warn(`║     Buy  queue    : ${depthResult.buyQty.toLocaleString('en-IN')} shares`);
  logger.warn(`║     Sell queue    : ${depthResult.sellQty.toLocaleString('en-IN')} shares`);
  logger.warn(`║     Sell/Buy ratio: ${depthResult.ratio.toFixed(4)} (threshold: ${DEPTH_THRESHOLD})`);
  logger.warn('╠══════════════════════════════════════════════════════════════╣');
  logger.warn(`║  LTP     : ${ltp}`);
  logger.warn(`║  Holding : ${holding.quantity} shares @ ${avg}`);
  logger.warn(`║  Action  : ${AUTO_SELL ? '🤖 AUTO-SELL TRIGGERED' : '⚠️  LOG ONLY – set AUTO_SELL_ON_SPIKE=true to auto-sell'}`);
  logger.warn('╚══════════════════════════════════════════════════════════════╝');
  logger.warn('');
}

// ── Tick handler ──────────────────────────────────────────────────────────────

/**
 * Called on every WebSocket tick.  Runs both signal checks.
 * Only fires if BOTH signals are active simultaneously.
 */
function handleTick(tick) {
  const holding  = holdingsMap.get(tick.instrument_token);
  if (!holding)  return;

  const baseline = baselines.get(tick.instrument_token);
  if (!baseline) return;

  // ── GUARD: never act on a stock already sold today ────────────────────────
  if (soldToday.has(tick.instrument_token)) return;

  // ── SIGNAL CHECK: dual-signal operator exit (volume + depth) ─────────────
  const volResult   = checkVolumeSpike(tick, baseline);
  const depthResult = checkDepthSpike(tick);

  if (volResult.fired && depthResult.fired) {
    // Cooldown – don't spam alerts for the same stock
    const now       = Date.now();
    const lastAlert = lastAlertAt.get(tick.instrument_token) || 0;

    if (now - lastAlert >= COOLDOWN_SEC * 1000) {
      lastAlertAt.set(tick.instrument_token, now);
      logAlert(holding, tick, volResult, depthResult);

      if (AUTO_SELL) {
        const reason = `vol:${volResult.ratio.toFixed(2)}x depth:${depthResult.ratio.toFixed(4)}`;
        triggerSell(holding, tick.last_price, reason).catch((err) =>
          logger.error(`triggerSell error: ${err.message}`)
        );
      }
    }
  }

  // ── STOP-LOSS CHECK: price deviated from previous day's close ─────────────
  // This catches the scenario where the stock is no longer in upper circuit
  // and is actively falling — regardless of whether the dual-signal fired.
  //
  // tick.ohlc.close = previous day's closing price (for T2T stocks in upper
  // circuit, this equals yesterday's upper circuit price).
  if (STOP_LOSS_ENABLED) {
    const prevClose = tick.ohlc?.close;

    if (prevClose && prevClose > 0) {
      const dropPct = ((prevClose - tick.last_price) / prevClose) * 100;

      logger.debug(
        `STOP-LOSS ${holding.tradingsymbol}: LTP=${tick.last_price} ` +
        `prevClose=${prevClose} drop=${dropPct.toFixed(2)}% threshold=${STOP_LOSS_PCT}%`
      );

      if (dropPct >= STOP_LOSS_PCT) {
        // Cooldown reuse — same mechanism, prevents log/order storms
        const now       = Date.now();
        const lastAlert = lastAlertAt.get(tick.instrument_token) || 0;

        if (now - lastAlert >= COOLDOWN_SEC * 1000) {
          lastAlertAt.set(tick.instrument_token, now);

          logger.warn('');
          logger.warn('╔══════════════════════════════════════════════════════════════╗');
          logger.warn(`║  📉 STOP-LOSS TRIGGERED  –  ${holding.tradingsymbol}`);
          logger.warn('╠══════════════════════════════════════════════════════════════╣');
          logger.warn(`║  Price has dropped ${dropPct.toFixed(2)}% below previous day's close`);
          logger.warn(`║  Previous close (upper circuit) : ${formatCurrency(prevClose)}`);
          logger.warn(`║  Current LTP                    : ${formatCurrency(tick.last_price)}`);
          logger.warn(`║  Stop-loss threshold            : ${STOP_LOSS_PCT}%`);
          logger.warn(`║  Your holding                   : ${holding.quantity} shares @ ${formatCurrency(holding.average_price)}`);
          logger.warn(`║  Action: ${AUTO_SELL
            ? '🤖 AUTO-SELL TRIGGERED'
            : '⚠️  LOG ONLY – set AUTO_SELL_ON_SPIKE=true to enable auto-sell'}`);
          logger.warn('╚══════════════════════════════════════════════════════════════╝');
          logger.warn('');

          if (AUTO_SELL) {
            const reason = `stop-loss:${dropPct.toFixed(2)}%_below_prev_close`;
            triggerSell(holding, tick.last_price, reason).catch((err) =>
              logger.error(`triggerSell (stop-loss) error: ${err.message}`)
            );
          }
        }
      }
    }
  }
}

// ── Periodic holdings refresh ─────────────────────────────────────────────────

async function refreshHoldings(kite, ticker) {
  try {
    logger.info('🔄 Refreshing holdings list…');
    await loadHoldingsAndBaselines(kite);

    if (holdingsMap.size > 0) {
      const tokens = [...holdingsMap.keys()];
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeFull, tokens);
      logger.info(`   Re-subscribed to ${tokens.length} instrument(s)`);
    }
  } catch (err) {
    logger.warn('Holdings refresh failed', { error: err.message });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function startHoldingsMonitor() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║   📡  HOLDINGS SPIKE MONITOR  starting…             ║');
  logger.info('╠══════════════════════════════════════════════════════╣');
  logger.info(`║  AUTO-SELL        : ${AUTO_SELL ? '🔴 ENABLED – will sell on spike' : '🟡 DISABLED – log alerts only'}`.padEnd(55) + '║');
  logger.info(`║  Volume lookback  : last ${LOOKBACK_DAYS} days (median)`.padEnd(55) + '║');
  logger.info(`║  Volume trigger   : ${VOL_MULTIPLIER}× expected (time-adjusted)`.padEnd(55) + '║');
  logger.info(`║  Depth trigger    : sell/buy ratio ≥ ${DEPTH_THRESHOLD}`.padEnd(55) + '║');
  logger.info(`║  Both signals must fire to trigger alert / sell`.padEnd(55) + '║');
  logger.info(`║  Alert cooldown   : ${COOLDOWN_SEC}s per stock`.padEnd(55) + '║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');

  if (AUTO_SELL && isDryRun()) {
    logger.warn('⚠️  AUTO_SELL_ON_SPIKE=true but DRY_RUN=true → sells will be simulated only');
  }

  const kite = getKiteClient();
  kiteClient = kite;

  // Step 1: Load holdings + compute volume baselines
  logger.info('Step 1/3: Loading holdings and computing volume baselines…');
  await loadHoldingsAndBaselines(kite);

  if (holdingsMap.size === 0) {
    logger.info('⚠️  No holdings found. Holdings monitor will exit.');
    return;
  }

  // Step 2: Start WebSocket ticker
  // We wait up to 30 seconds for the connection to be confirmed.
  // If it doesn't connect in time we log a clear diagnostic and exit the
  // spike monitor — but the rest of the bot (orders + polling) keeps running.
  logger.info(`Step 2/3: Starting WebSocket for ${holdingsMap.size} instrument(s)…`);
  logger.info('   Waiting for Kite Ticker connection (timeout: 30s)…');

  const tokens = [...holdingsMap.keys()];
  const ticker = startTicker(tokens);

  // Race: either 'connect' fires within 30s, or we time out
  const connected = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false); // timed out
    }, 30_000);

    ticker.once('connect', () => {
      clearTimeout(timeout);
      resolve(true); // connected!
    });

    // If an error fires before connect, resolve false immediately
    ticker.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  if (!connected) {
    logger.error('');
    logger.error('╔══════════════════════════════════════════════════════════════╗');
    logger.error('║  ⚠️   HOLDINGS SPIKE MONITOR – WebSocket NOT connected       ║');
    logger.error('╠══════════════════════════════════════════════════════════════╣');
    logger.error('║  The Kite Ticker (WebSocket) did not connect within 30s.     ║');
    logger.error('║                                                               ║');
    logger.error('║  Most likely cause:                                           ║');
    logger.error('║  → You have not subscribed to Kite Connect WebSocket         ║');
    logger.error('║    (KiteTicker) on your developer account.                   ║');
    logger.error('║    Activate it at: https://developers.kite.trade/            ║');
    logger.error('║                                                               ║');
    logger.error('║  Other possible causes:                                       ║');
    logger.error('║  → Expired access token  (re-run: node src/login.js)         ║');
    logger.error('║  → No internet connection                                     ║');
    logger.error('║  → Kite servers temporarily down                              ║');
    logger.error('╠══════════════════════════════════════════════════════════════╣');
    logger.error('║  Spike monitor has been DISABLED for this session.           ║');
    logger.error('║  Order placement and polling monitor are unaffected.         ║');
    logger.error('╚══════════════════════════════════════════════════════════════╝');
    logger.error('');
    return; // exit spike monitor gracefully; rest of bot keeps running
  }

  // Step 3: Wire our spike-detection handler onto the ticker's ticks event
  // (The existing handler in websocket.js also runs – it updates latestTicks.
  //  Node EventEmitter supports multiple listeners; both will execute.)
  ticker.on('ticks', (ticks) => ticks.forEach(handleTick));

  logger.info('Step 3/3: Holdings spike monitor is ACTIVE.');
  logger.info(`   Watching: ${[...holdingsMap.values()].map((h) => h.tradingsymbol).join(', ')}`);
  logger.info('');

  // Refresh holdings periodically (picks up new buys during the day)
  setInterval(() => refreshHoldings(kite, ticker), REFRESH_MS);
}

module.exports = { startHoldingsMonitor };
