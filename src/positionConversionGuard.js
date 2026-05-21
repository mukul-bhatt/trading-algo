/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/positionConversionGuard.js  –  Lower → Upper Circuit Conversion Guard
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS DOES:
 * ───────────────
 * Protects you from getting your SELL order filled at a bad price when a
 * penny stock is converting from lower circuit to upper circuit.
 *
 * THE SCENARIO:
 *   1. You own a penny stock stuck at lower circuit for days.
 *   2. You've placed a CNC SELL order (pending, waiting for a buyer).
 *   3. The operator suddenly enters — injecting massive buy volume.
 *   4. The stock starts racing from lower circuit → upper circuit in minutes.
 *   5. During this chaotic conversion, your SELL might fill at a bad price.
 *   6. If the stock reaches upper circuit, it would be +5% to +10% from the
 *      lower circuit floor — you've left that entire profit on the table.
 *
 * WHAT WE DO:
 *   Monitor ALL open SELL orders in your account in real-time via WebSocket.
 *   When BOTH signals fire simultaneously for a stock with an open SELL:
 *     SIGNAL 1 – Price Lift:    LTP >= lower_circuit × (1 + PRICE_LIFT_PCT%)
 *     SIGNAL 2 – Volume Spike:  actual_volume >= VOL_MULTIPLIER × expected_vol
 *
 *   → Automatically cancel the open SELL order
 *   → Print a loud, impossible-to-miss alert in the terminal
 *   → You then decide manually what to do next (e.g. re-queue at upper circuit)
 *
 * WHY DUAL-SIGNAL?
 *   Price alone can be noisy — intraday bounces of 1–2% happen.
 *   Volume alone can spike for other reasons (block deals, ex-dates).
 *   BOTH together is a strong, reliable signal of operator entry.
 *
 *   FALLBACK: If the Historical Data API add-on is not available, volume
 *   baseline cannot be computed. The module falls back to price-lift only.
 *   This is less reliable but still useful.
 *
 * ARCHITECTURE:
 *   • REST poll (kite.getOrders) at startup + every REFRESH_MS to build watch list
 *   • kite.getQuote() at startup to get lower/upper circuit limits
 *   • Resolves instrument tokens for WebSocket subscription
 *   • Hooks into the SAME WebSocket ticker as holdingsMonitor.js
 *   • On each tick → run dual-signal check → act if both fire
 *
 * ENV VARIABLES:
 *   CONVERSION_GUARD_ENABLED=true          false = disable this module entirely
 *   CONVERSION_PRICE_LIFT_PCT=2.0          % above lower circuit to detect lift
 *   CONVERSION_VOL_MULTIPLIER=3.0          volume spike multiplier
 *   CONVERSION_COOLDOWN_SECONDS=120        min seconds between alerts per stock
 *   CONVERSION_AUTO_CANCEL=false           false=alert only | true=auto-cancel SELL
 *   CONVERSION_REFRESH_MS=300000           how often to re-fetch open SELL orders
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger            = require('./logger');
const { getKiteClient } = require('./login');
const { retry, formatCurrency, isDryRun, sleep, isMarketHours } = require('./utils');
const { startTicker }   = require('./websocket');

// ── Config ────────────────────────────────────────────────────────────────────

const GUARD_ENABLED  = process.env.CONVERSION_GUARD_ENABLED     !== 'false'; // default ON
const PRICE_LIFT_PCT = parseFloat(process.env.CONVERSION_PRICE_LIFT_PCT     || '2.0');
const VOL_MULTIPLIER = parseFloat(process.env.CONVERSION_VOL_MULTIPLIER     || '3.0');
const COOLDOWN_SEC   = parseInt(process.env.CONVERSION_COOLDOWN_SECONDS     || '120', 10);
const AUTO_CANCEL    = process.env.CONVERSION_AUTO_CANCEL                   === 'true';
const REFRESH_MS     = parseInt(process.env.CONVERSION_REFRESH_MS           || '300000', 10);
const LOOKBACK_DAYS  = parseInt(process.env.VOLUME_LOOKBACK_DAYS            || '7', 10);

// NSE trades 375 minutes/day (9:15 AM – 3:30 PM)
const TRADING_MINUTES = 375;

// ── In-memory state ───────────────────────────────────────────────────────────

/**
 * Map<instrumentToken, WatchEntry>
 *
 * WatchEntry = {
 *   tradingsymbol     : string,
 *   exchange          : string,
 *   instrument_token  : number,
 *   lower_circuit     : number,   // today's lower circuit limit (from getQuote)
 *   upper_circuit     : number,   // today's upper circuit limit (from getQuote)
 *   medianVolume      : number|null,
 *   openSellOrders    : Array<{ order_id, quantity, price, order_type }>
 * }
 */
const watchMap = new Map();

// Map<instrumentToken, lastAlertTimestampMs> — cooldown tracker
const lastAlertAt = new Map();

// Set<order_id> — orders already cancelled today (prevents double-cancel)
const cancelledToday = new Set();

// Reference to kite client set on startup
let kiteClient = null;

// Reference to ticker set on startup
let activeTicker = null;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the median of a numeric array.
 * Same logic as holdingsMonitor — robust to outlier days.
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

// ── Historical volume baseline ────────────────────────────────────────────────

/**
 * Fetches N-day median daily volume for a given instrument.
 * Returns null if the Historical Data API add-on is not subscribed.
 */
async function fetchMedianVolume(kite, instrumentToken, tradingsymbol) {
  try {
    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (LOOKBACK_DAYS * 2 + 7)); // buffer for weekends/holidays

    const fromStr = from.toISOString().slice(0, 10);
    const toStr   = to.toISOString().slice(0, 10);

    const candles = await retry(
      () => kite.getHistoricalData(instrumentToken, 'day', fromStr, toStr),
      { maxAttempts: 1, label: `historicalData:${tradingsymbol}` }
    );

    if (!candles || candles.length === 0) {
      logger.warn(`⚠️  Conversion guard: no historical data for ${tradingsymbol} – volume signal disabled`);
      return null;
    }

    // Exclude today's partial candle (last entry if market is open)
    const completedDays = candles.slice(-(LOOKBACK_DAYS + 1), -1);
    const volumes = completedDays.map((c) => c.volume).filter((v) => v > 0);

    if (volumes.length === 0) {
      logger.warn(`⚠️  Conversion guard: all-zero volumes for ${tradingsymbol} – volume signal disabled`);
      return null;
    }

    const med = median(volumes);
    logger.info(
      `   📊 ${tradingsymbol.padEnd(15)} ${volumes.length}-day median vol: ` +
      `${med.toLocaleString('en-IN')} shares`
    );
    return med;

  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('insufficient permission')) {
      logger.warn(
        `⚠️  Historical Data API not available for ${tradingsymbol} ` +
        `(plan add-on required). Volume signal disabled – price-lift signal still active.`
      );
    } else {
      logger.warn(`⚠️  Conversion guard: could not fetch history for ${tradingsymbol}: ${err.message}`);
    }
    return null;
  }
}

// ── Instrument token resolution ───────────────────────────────────────────────

/**
 * Resolves instrument tokens for a list of { tradingsymbol, exchange } objects.
 *
 * kite.getQuote() returns an object keyed by "EXCHANGE:SYMBOL". The quote
 * includes `instrument_token` which is what the WebSocket needs.
 *
 * Returns Map<"EXCHANGE:SYMBOL", instrumentToken>
 */
async function resolveInstrumentTokens(kite, instruments) {
  const keys = instruments.map((i) => `${i.exchange}:${i.tradingsymbol}`);

  let quotes;
  try {
    quotes = await retry(
      () => kite.getQuote(keys),
      { maxAttempts: 3, label: 'getQuote:conversionGuard:tokenResolve' }
    );
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('insufficient permission')) {
      const permErr = new Error('PERMISSION_DENIED');
      permErr.isPermissionDenied = true;
      throw permErr;
    }
    logger.warn(`Conversion guard: getQuote failed during token resolve – ${err.message}`);
    return new Map();
  }

  const result = new Map();
  for (const key of keys) {
    const q = quotes[key];
    if (q && q.instrument_token) {
      result.set(key, {
        instrument_token : q.instrument_token,
        lower_circuit    : q.lower_circuit_limit || 0,
        upper_circuit    : q.upper_circuit_limit || 0,
        last_price       : q.last_price          || 0,
      });
    } else {
      logger.warn(`Conversion guard: no quote for ${key} – skipping`);
    }
  }
  return result;
}

// ── Open SELL order fetching ──────────────────────────────────────────────────

/**
 * Fetches ALL open SELL orders from Kite (any symbol, not just basket.json).
 * Filters out orders we've already cancelled.
 *
 * Returns an array grouped by symbol:
 * [
 *   { tradingsymbol, exchange, orders: [{ order_id, quantity, price, order_type }] }
 * ]
 */
async function fetchOpenSellOrders(kite) {
  const allOrders = await retry(
    () => kite.getOrders(),
    { maxAttempts: 3, label: 'getOrders:conversionGuard' }
  );

  // Filter: open CNC SELL orders not already cancelled by us
  const openSells = allOrders.filter((o) =>
    (o.status === 'OPEN' || o.status === 'TRIGGER PENDING') &&
    o.transaction_type === 'SELL'                           &&
    o.product          === 'CNC'                           &&
    !cancelledToday.has(o.order_id)
  );

  if (openSells.length === 0) return [];

  // Group by symbol
  const symbolMap = new Map();
  for (const o of openSells) {
    const key = `${o.exchange}:${o.tradingsymbol}`;
    if (!symbolMap.has(key)) {
      symbolMap.set(key, {
        tradingsymbol : o.tradingsymbol,
        exchange      : o.exchange,
        orders        : [],
      });
    }
    symbolMap.get(key).orders.push({
      order_id   : o.order_id,
      quantity   : o.pending_quantity || o.quantity,
      price      : o.price,
      order_type : o.order_type,
    });
  }

  return [...symbolMap.values()];
}

// ── Signal checks ─────────────────────────────────────────────────────────────

/**
 * SIGNAL 1: Price Lift
 *
 * The stock must be trading meaningfully ABOVE its lower circuit floor.
 * Default threshold: 2% above the lower circuit limit.
 *
 * Why 2%? A stock exactly at lower circuit can have micro-bounces of 0.5–1%
 * due to small trades. 2% is meaningful — it signals actual buying pressure.
 */
function checkPriceLift(tick, entry) {
  const ltp          = tick.last_price;
  const lowerCircuit = entry.lower_circuit;

  if (!lowerCircuit || lowerCircuit <= 0) {
    return { fired: false, reason: 'no lower circuit data' };
  }

  const liftThreshold = lowerCircuit * (1 + PRICE_LIFT_PCT / 100);
  const liftPct       = ((ltp - lowerCircuit) / lowerCircuit) * 100;
  const fired         = ltp >= liftThreshold;

  logger.debug(
    `LIFT ${entry.tradingsymbol}: LTP=${ltp} lower=${lowerCircuit} ` +
    `threshold=${liftThreshold.toFixed(2)} lift=${liftPct.toFixed(2)}% fired=${fired}`
  );

  return { fired, ltp, lowerCircuit, liftPct: liftPct.toFixed(2), liftThreshold };
}

/**
 * SIGNAL 2: Volume Spike (time-adjusted)
 *
 * Same formula as holdingsMonitor.js:
 *   expected = (medianDailyVolume / 375 min) × elapsed_min
 *   fired    = actual >= VOL_MULTIPLIER × expected
 *
 * Fallback: if no baseline, signal cannot fire (returns fired=false with reason).
 */
function checkVolumeSpike(tick, entry) {
  if (!entry.medianVolume) {
    return { fired: false, reason: 'no volume baseline' };
  }

  const elapsed  = minutesSinceOpen();
  const expected = (entry.medianVolume / TRADING_MINUTES) * elapsed;
  const actual   = tick.volume_traded || 0;
  const ratio    = actual / Math.max(expected, 1);

  logger.debug(
    `VOL ${entry.tradingsymbol}: actual=${actual.toLocaleString('en-IN')} ` +
    `expected=${Math.round(expected).toLocaleString('en-IN')} ratio=${ratio.toFixed(2)}x`
  );

  return {
    fired    : ratio >= VOL_MULTIPLIER,
    ratio,
    actual,
    expected : Math.round(expected),
  };
}

// ── Alert ─────────────────────────────────────────────────────────────────────

/**
 * Prints a loud, visually prominent terminal alert.
 * Designed to be impossible to miss at a glance.
 */
function logConversionAlert(entry, tick, liftResult, volResult, ordersBeingCancelled) {
  const ts       = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const hasVol   = volResult.fired !== undefined && volResult.actual !== undefined;
  const upperStr = entry.upper_circuit > 0
    ? `${formatCurrency(entry.upper_circuit)}  (+${(((entry.upper_circuit - entry.lower_circuit) / entry.lower_circuit) * 100).toFixed(1)}% from floor)`
    : '(unknown)';

  logger.warn('');
  logger.warn('╔══════════════════════════════════════════════════════════════════╗');
  logger.warn(`║  🚀🚀  CONVERSION ALERT: LOWER → UPPER CIRCUIT  –  ${entry.tradingsymbol.padEnd(12)}║`);
  logger.warn(`║  Time          : ${ts} IST`.padEnd(69) + '║');
  logger.warn('╠══════════════════════════════════════════════════════════════════╣');
  logger.warn('║  📈 PRICE LIFT                                                   ║');
  logger.warn(`║     Lower Circuit   : ${formatCurrency(entry.lower_circuit)}`.padEnd(69) + '║');
  logger.warn(`║     Current LTP     : ${formatCurrency(liftResult.ltp)}  (+${liftResult.liftPct}% above floor)`.padEnd(69) + '║');
  logger.warn(`║     Upper Circuit   : ${upperStr}`.padEnd(69) + '║');
  logger.warn(`║     Trigger         : ≥ ${PRICE_LIFT_PCT}% above floor (threshold: ${formatCurrency(liftResult.liftThreshold)})`.padEnd(69) + '║');
  logger.warn('╠══════════════════════════════════════════════════════════════════╣');
  if (hasVol) {
    logger.warn('║  📊 VOLUME SPIKE                                                 ║');
    logger.warn(`║     Actual today    : ${volResult.actual.toLocaleString('en-IN')} shares`.padEnd(69) + '║');
    logger.warn(`║     Expected by now : ${volResult.expected.toLocaleString('en-IN')} shares`.padEnd(69) + '║');
    logger.warn(`║     Spike ratio     : ${volResult.ratio.toFixed(2)}×  (threshold: ${VOL_MULTIPLIER}×)`.padEnd(69) + '║');
  } else {
    logger.warn('║  📊 VOLUME SIGNAL   : N/A (Historical Data API not subscribed)   ║');
    logger.warn('║     Running in price-lift only mode                               ║');
  }
  logger.warn('╠══════════════════════════════════════════════════════════════════╣');
  logger.warn('║  ⚠️  OPEN SELL ORDER(S) DETECTED                                 ║');
  for (const o of ordersBeingCancelled) {
    logger.warn(`║     Order ID   : ${o.order_id}`.padEnd(69) + '║');
    logger.warn(`║     Qty        : ${o.quantity} shares  ${o.order_type} @ ${formatCurrency(o.price)}`.padEnd(69) + '║');
  }
  logger.warn(`║  Action : ${AUTO_CANCEL
    ? '🤖 AUTO-CANCEL → cancelling now…                        '
    : '⚠️  LOG ONLY  →  set CONVERSION_AUTO_CANCEL=true to auto-cancel '}`.padEnd(69) + '║');
  logger.warn('╠══════════════════════════════════════════════════════════════════╣');
  logger.warn('║  💡 SUGGESTED NEXT STEP:                                         ║');
  if (entry.upper_circuit > 0) {
    logger.warn(`║     Stock may reach upper circuit ${formatCurrency(entry.upper_circuit)}`.padEnd(69) + '║');
    logger.warn(`║     Consider re-queuing a SELL at upper circuit price.            ║`);
  } else {
    logger.warn('║     Monitor the stock manually and re-queue your SELL if needed.  ║');
  }
  logger.warn('╚══════════════════════════════════════════════════════════════════╝');
  logger.warn('');
}

// ── Cancel open SELL orders ───────────────────────────────────────────────────

/**
 * Cancels each open SELL order for a stock that is converting.
 * Respects DRY_RUN mode and the AUTO_CANCEL flag.
 */
async function cancelSellOrders(entry) {
  if (!AUTO_CANCEL) return; // Alert-only mode

  for (const o of entry.openSellOrders) {
    if (cancelledToday.has(o.order_id)) continue;

    if (isDryRun()) {
      logger.warn(`🧪 [DRY RUN] Would cancel: SELL order_id ${o.order_id}  ${entry.tradingsymbol}  qty:${o.quantity}`);
      cancelledToday.add(o.order_id);
      continue;
    }

    try {
      await retry(
        () => kiteClient.cancelOrder('regular', o.order_id),
        { maxAttempts: 2, delayMs: 500, label: `cancelSell:${entry.tradingsymbol}:${o.order_id}` }
      );
      cancelledToday.add(o.order_id);
      logger.warn(
        `✅ SELL ORDER CANCELLED: ${entry.tradingsymbol}  qty:${o.quantity}  ` +
        `price:${formatCurrency(o.price)}  order_id:${o.order_id}`
      );
    } catch (err) {
      logger.error(
        `❌ Failed to cancel SELL order for ${entry.tradingsymbol} (order_id: ${o.order_id})`,
        { error: err.message }
      );
    }
  }
}

// ── WebSocket tick handler ────────────────────────────────────────────────────

/**
 * Called on every WebSocket tick.
 * Checks both signals; fires alert + cancel if either/both conditions met.
 *
 * Signal evaluation logic:
 *  - If volume baseline exists: BOTH price-lift AND volume-spike must fire (dual-signal)
 *  - If no baseline (no historical data add-on): price-lift alone is sufficient (fallback)
 */
function handleTick(tick) {
  const entry = watchMap.get(tick.instrument_token);
  if (!entry) return;

  // Skip if all sell orders for this stock are already cancelled
  const activeOrders = entry.openSellOrders.filter((o) => !cancelledToday.has(o.order_id));
  if (activeOrders.length === 0) return;

  // ── Run signals ────────────────────────────────────────────────────────────
  const liftResult = checkPriceLift(tick, entry);
  const volResult  = checkVolumeSpike(tick, entry);

  const hasVolBaseline = !!entry.medianVolume;
  const signalFired    = hasVolBaseline
    ? (liftResult.fired && volResult.fired)   // dual-signal (preferred)
    : liftResult.fired;                       // price-lift only fallback

  if (!signalFired) return;

  // ── Cooldown ───────────────────────────────────────────────────────────────
  const now       = Date.now();
  const lastAlert = lastAlertAt.get(tick.instrument_token) || 0;
  if (now - lastAlert < COOLDOWN_SEC * 1000) return;

  lastAlertAt.set(tick.instrument_token, now);

  // ── Fire! ──────────────────────────────────────────────────────────────────
  logConversionAlert(entry, tick, liftResult, volResult, activeOrders);

  cancelSellOrders(entry).catch((err) =>
    logger.error(`cancelSellOrders error for ${entry.tradingsymbol}: ${err.message}`)
  );
}

// ── Watch list management ─────────────────────────────────────────────────────

/**
 * Builds or refreshes the watch list:
 *   1. Fetches all open SELL orders
 *   2. Resolves circuit limits + instrument tokens via getQuote
 *   3. Fetches median volume baseline for any new entries
 *   4. Updates watchMap and subscribes new tokens to the WebSocket
 */
async function refreshWatchList(kite, ticker) {
  if (!isMarketHours()) {
    logger.debug('Conversion guard: market closed – skipping refresh');
    return;
  }

  // Step 1: get open SELL orders
  let grouped;
  try {
    grouped = await fetchOpenSellOrders(kite);
  } catch (err) {
    logger.warn(`Conversion guard: could not fetch orders – ${err.message}`);
    return;
  }

  if (grouped.length === 0) {
    logger.debug('Conversion guard: no open CNC SELL orders to watch');
    return;
  }

  logger.info(`🔄 Conversion guard: ${grouped.length} symbol(s) with open SELL orders`);

  // Step 2: resolve circuit limits + instrument tokens via getQuote
  let quoteData;
  try {
    quoteData = await resolveInstrumentTokens(kite, grouped);
  } catch (err) {
    if (err.isPermissionDenied) throw err;
    logger.warn(`Conversion guard: could not resolve tokens – ${err.message}`);
    return;
  }

  const newTokens = [];

  for (const group of grouped) {
    const key   = `${group.exchange}:${group.tradingsymbol}`;
    const quote = quoteData.get(key);

    if (!quote) {
      logger.warn(`Conversion guard: no quote data for ${key} – skipping`);
      continue;
    }

    const token = quote.instrument_token;

    if (!watchMap.has(token)) {
      // New entry — need to fetch volume baseline
      logger.info(`   🔍 Fetching volume baseline for ${group.tradingsymbol}…`);
      const medVol = await fetchMedianVolume(kite, token, group.tradingsymbol);
      await sleep(350); // rate-limit protection

      watchMap.set(token, {
        tradingsymbol    : group.tradingsymbol,
        exchange         : group.exchange,
        instrument_token : token,
        lower_circuit    : quote.lower_circuit,
        upper_circuit    : quote.upper_circuit,
        medianVolume     : medVol,
        openSellOrders   : group.orders,
      });
      newTokens.push(token);

      logger.info(
        `   ✅ Watching ${group.tradingsymbol}  ` +
        `lower_circuit=${formatCurrency(quote.lower_circuit)}  ` +
        `upper_circuit=${formatCurrency(quote.upper_circuit)}  ` +
        `vol_baseline=${medVol ? medVol.toLocaleString('en-IN') + ' shares/day' : 'N/A'}`
      );
    } else {
      // Existing entry — just refresh the circuit limits and order list
      // (circuit limits can change if SEBI revises them mid-session, rare but possible)
      const existing = watchMap.get(token);
      existing.lower_circuit  = quote.lower_circuit;
      existing.upper_circuit  = quote.upper_circuit;
      existing.openSellOrders = group.orders;
    }
  }

  // Remove stocks from watchMap that no longer have open SELL orders
  for (const [token, entry] of watchMap) {
    const stillWatched = grouped.some(
      (g) => g.tradingsymbol === entry.tradingsymbol && g.exchange === entry.exchange
    );
    if (!stillWatched) {
      logger.info(`   ℹ️  ${entry.tradingsymbol}: no open SELL orders remaining – removing from watch`);
      watchMap.delete(token);
    }
  }

  // Step 3: subscribe new tokens to the WebSocket ticker
  if (ticker && newTokens.length > 0) {
    ticker.subscribe(newTokens);
    ticker.setMode(ticker.modeFull, newTokens);
    logger.info(`   📡 Subscribed ${newTokens.length} new instrument(s) to WebSocket`);
  }

  if (watchMap.size > 0) {
    logger.info(`   👁️  Actively watching: ${[...watchMap.values()].map((e) => e.tradingsymbol).join(', ')}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function startPositionConversionGuard() {
  if (!GUARD_ENABLED) {
    logger.info('🔒 Position Conversion Guard is DISABLED (CONVERSION_GUARD_ENABLED=false)');
    return;
  }

  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║   🚀  POSITION CONVERSION GUARD  starting…          ║');
  logger.info('╠══════════════════════════════════════════════════════╣');
  logger.info(`║  AUTO-CANCEL      : ${AUTO_CANCEL
    ? '🔴 ENABLED – will cancel SELL on signal'
    : '🟡 DISABLED – alert only (set CONVERSION_AUTO_CANCEL=true)'}`.padEnd(55) + '║');
  logger.info(`║  Price lift trigger: ≥ ${PRICE_LIFT_PCT}% above lower circuit`.padEnd(55) + '║');
  logger.info(`║  Volume trigger   : ${VOL_MULTIPLIER}× expected (time-adjusted)`.padEnd(55) + '║');
  logger.info(`║  Both signals fire together (fallback: price-lift only)`.padEnd(55) + '║');
  logger.info(`║  Alert cooldown   : ${COOLDOWN_SEC}s per stock`.padEnd(55) + '║');
  logger.info(`║  Watches          : ALL open CNC SELL orders`.padEnd(55) + '║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');

  if (AUTO_CANCEL && isDryRun()) {
    logger.warn('⚠️  CONVERSION_AUTO_CANCEL=true but DRY_RUN=true → cancels will be simulated only');
  }

  const kite = getKiteClient();
  kiteClient = kite;

  // Step 1: Load open SELL orders + resolve circuit limits + volume baselines
  logger.info('Step 1/3: Loading open SELL orders and computing baselines…');

  let grouped;
  try {
    grouped = await fetchOpenSellOrders(kite);
  } catch (err) {
    logger.warn(`⚠️  Conversion guard: could not fetch orders – ${err.message}`);
    logger.warn('   Conversion guard will NOT run.');
    return;
  }

  if (grouped.length === 0) {
    logger.info('ℹ️  No open CNC SELL orders found. Conversion guard idle.');
    logger.info('   It will wake up and start watching as soon as you place a SELL order.');
    // Still start the ticker + refresh loop so it activates dynamically
  } else {
    logger.info(`   Found ${grouped.length} symbol(s) with open SELL orders.`);
  }

  // Step 2: Start WebSocket ticker (reuses the same pattern as holdingsMonitor)
  logger.info('Step 2/3: Starting WebSocket ticker…');
  logger.info('   Waiting for Kite Ticker connection (timeout: 30s)…');

  // Start with whatever tokens we have so far (may be empty if no SELL orders yet)
  const initialTokens = [];
  const ticker = startTicker(initialTokens);
  activeTicker = ticker;

  const connected = await new Promise((resolve) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) { settled = true; resolve(false); }
    }, 30_000);

    function onConnect() {
      ticker.on('connect', () => {}); // satisfy KiteTicker
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      }
    }
    function onError() {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(false);
      }
    }

    ticker.on('connect', onConnect);
    ticker.on('error',   onError);
  });

  if (!connected) {
    logger.error('');
    logger.error('╔══════════════════════════════════════════════════════════════╗');
    logger.error('║  ⚠️   CONVERSION GUARD – WebSocket NOT connected             ║');
    logger.error('╠══════════════════════════════════════════════════════════════╣');
    logger.error('║  The Kite Ticker did not connect within 30s.                 ║');
    logger.error('║  → Check: https://developers.kite.trade/                     ║');
    logger.error('║  → Or re-authenticate: node src/login.js <request_token>    ║');
    logger.error('║  Conversion guard has been DISABLED for this session.        ║');
    logger.error('╚══════════════════════════════════════════════════════════════╝');
    logger.error('');
    return;
  }

  // Step 3: Wire tick handler + do initial refresh to subscribe instruments
  logger.info('Step 3/3: Wiring tick handler and subscribing instruments…');
  ticker.on('ticks', (ticks) => ticks.forEach(handleTick));

  // Now do the initial watchlist population (this subscribes tokens to WS)
  try {
    await refreshWatchList(kite, ticker);
  } catch (err) {
    if (err.isPermissionDenied) {
      logger.warn('');
      logger.warn('🚀 Conversion Guard DISABLED for this session.');
      logger.warn('   Reason: kite.getQuote() returned "Insufficient permission".');
      logger.warn('   Circuit limit data is required to detect lower→upper conversions.');
      logger.warn('   → To enable: upgrade your Kite Connect subscription at');
      logger.warn('     https://developers.kite.trade/');
      logger.warn('');
      return;
    }
    logger.warn(`Conversion guard: initial refresh failed – ${err.message}`);
  }

  logger.info('🚀 Position Conversion Guard is ACTIVE.');
  if (watchMap.size > 0) {
    logger.info(`   Watching: ${[...watchMap.values()].map((e) => e.tradingsymbol).join(', ')}`);
  } else {
    logger.info('   No open SELL orders right now. Will detect automatically on refresh.');
  }
  logger.info('');

  // Periodic refresh — picks up new SELL orders placed during the day
  setInterval(async () => {
    try {
      logger.info('🔄 Conversion guard: refreshing open SELL orders…');
      await refreshWatchList(kite, activeTicker);
    } catch (err) {
      if (err.isPermissionDenied) {
        logger.warn('🚀 Conversion guard: permission denied during refresh — stopping.');
        return;
      }
      logger.warn(`Conversion guard: refresh failed – ${err.message}`);
    }
  }, REFRESH_MS);
}

module.exports = { startPositionConversionGuard };
