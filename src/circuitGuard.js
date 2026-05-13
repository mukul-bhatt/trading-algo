/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/circuitGuard.js  –  Lower Circuit Order Cancellation Guard
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS DOES:
 * ───────────────
 * Protects you from accidentally buying into a stock that the operator has
 * already exited.
 *
 * THE SCENARIO:
 *   1. Bot places a CNC BUY order for a penny stock at 9:00 AM.
 *   2. The order is PENDING because there are very few sellers.
 *   3. During the day, the operator dumps all their shares.
 *   4. The stock crashes and hits LOWER CIRCUIT.
 *   5. Your pending BUY order is still sitting there.
 *   6. If any panicking seller shows up at that price → your order fills.
 *   7. You've bought into a stock the operator has already left. BAD.
 *
 * WHAT WE DO:
 *   Every CIRCUIT_GUARD_INTERVAL_MS (default 30s), we:
 *     1. Fetch all OPEN BUY orders from Kite (today's session).
 *     2. Filter to only orders for stocks in your basket.json.
 *     3. Call kite.getQuote() for each such stock → this returns the
 *        exact lower_circuit_limit value for that stock.
 *     4. If last_price <= lower_circuit_limit → stock is AT lower circuit.
 *     5. Cancel that pending BUY order automatically.
 *
 * WHY getQuote() AND NOT WebSocket?
 *   kite.getQuote() returns the field `lower_circuit_limit` directly — the
 *   exact price Zerodha/NSE has set as the lower limit for that stock today.
 *   There is no guessing or threshold math needed.
 *   WebSocket ticks do not include circuit limit values.
 *
 * ENV VARIABLES:
 *   CANCEL_ON_LOWER_CIRCUIT=false    false=log only | true=auto-cancel
 *   CIRCUIT_GUARD_INTERVAL_MS=30000  how often to check (default 30s)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger             = require('./logger');
const { getKiteClient }  = require('./login');
const { retry, isDryRun, isMarketHours, formatCurrency } = require('./utils');
const { loadBasket }     = require('./placeOrders');

// ── Config ────────────────────────────────────────────────────────────────────

const AUTO_CANCEL    = process.env.CANCEL_ON_LOWER_CIRCUIT    === 'true';
const GUARD_INTERVAL = parseInt(process.env.CIRCUIT_GUARD_INTERVAL_MS || '30000', 10);

// ── State ─────────────────────────────────────────────────────────────────────

// Tracks order IDs we've already cancelled today — prevents double-cancel attempts
const cancelledToday = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetches today's orders and returns only the ones that are:
 *  - Status: OPEN or TRIGGER PENDING (still cancellable)
 *  - Direction: BUY
 *  - Product: CNC (delivery — the only type we place)
 *  - Symbol: in our basket.json (we don't touch unrelated orders)
 *  - Not already cancelled by us today
 */
async function getOpenBuyOrders(kite, basketSymbols) {
  const orders = await retry(
    () => kite.getOrders(),
    { maxAttempts: 3, label: 'getOrders:circuitGuard' }
  );

  return orders.filter((o) =>
    (o.status === 'OPEN' || o.status === 'TRIGGER PENDING') &&
    o.transaction_type  === 'BUY'  &&
    o.product           === 'CNC'  &&
    basketSymbols.has(o.tradingsymbol) &&
    !cancelledToday.has(o.order_id)
  );
}

/**
 * For each open BUY order, fetches the live quote (which includes
 * lower_circuit_limit) and cancels the order if the stock is at lower circuit.
 */
async function checkAndCancelIfLowerCircuit(kite, openBuyOrders) {
  if (openBuyOrders.length === 0) return;

  // Build quote keys: Kite expects "NSE:SYMBOL" or "BSE:SYMBOL"
  const quoteKeys = [...new Set(
    openBuyOrders.map((o) => `${o.exchange}:${o.tradingsymbol}`)
  )];

  let quotes;
  try {
    quotes = await retry(
      () => kite.getQuote(quoteKeys),
      { maxAttempts: 3, label: 'getQuote:circuitGuard' }
    );
  } catch (err) {
    logger.warn(`🛡️  Circuit guard: getQuote failed – ${err.message}`);
    return;
  }

  for (const order of openBuyOrders) {
    const key   = `${order.exchange}:${order.tradingsymbol}`;
    const quote = quotes[key];

    if (!quote) {
      logger.warn(`🛡️  Circuit guard: no quote data for ${key} – skipping`);
      continue;
    }

    const ltp          = quote.last_price;
    const lowerCircuit = quote.lower_circuit_limit;

    if (!lowerCircuit || lowerCircuit <= 0) {
      // Some stocks don't have circuit limits (e.g. F&O)
      logger.debug(`Circuit guard: ${order.tradingsymbol} has no lower circuit limit`);
      continue;
    }

    const atLowerCircuit = ltp <= lowerCircuit;

    logger.debug(
      `Circuit guard: ${order.tradingsymbol} LTP=${ltp} lower_circuit=${lowerCircuit} ` +
      `at_lower=${atLowerCircuit}`
    );

    if (!atLowerCircuit) continue;

    // ── LOWER CIRCUIT DETECTED ─────────────────────────────────────────────
    const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    logger.warn('');
    logger.warn('╔══════════════════════════════════════════════════════════════╗');
    logger.warn(`║  🔴 LOWER CIRCUIT DETECTED  –  ${order.tradingsymbol}`);
    logger.warn(`║  Time           : ${ts} IST`);
    logger.warn('╠══════════════════════════════════════════════════════════════╣');
    logger.warn(`║  Last Price     : ${formatCurrency(ltp)}`);
    logger.warn(`║  Lower Circuit  : ${formatCurrency(lowerCircuit)}`);
    logger.warn(`║  Open BUY Order : ${order.quantity} shares  [${order.order_type}]  ID: ${order.order_id}`);
    logger.warn(`║  Interpretation : Operator may have exited. DO NOT BUY.`);
    logger.warn('╠══════════════════════════════════════════════════════════════╣');
    logger.warn(`║  Action: ${AUTO_CANCEL
      ? '🤖 AUTO-CANCEL is ON → cancelling order now…'
      : '⚠️  LOG ONLY → set CANCEL_ON_LOWER_CIRCUIT=true to auto-cancel'}`);
    logger.warn('╚══════════════════════════════════════════════════════════════╝');
    logger.warn('');

    if (!AUTO_CANCEL) continue;

    // ── Auto-cancel ────────────────────────────────────────────────────────
    if (isDryRun()) {
      logger.warn(`🧪 [DRY RUN] Would cancel: order_id ${order.order_id} for ${order.tradingsymbol}`);
      cancelledToday.add(order.order_id); // mark so we don't log repeatedly
      continue;
    }

    try {
      await retry(
        () => kite.cancelOrder('regular', order.order_id),
        { maxAttempts: 2, delayMs: 500, label: `cancelOrder:${order.tradingsymbol}` }
      );

      cancelledToday.add(order.order_id);
      logger.warn(`✅ ORDER CANCELLED: ${order.tradingsymbol}  qty: ${order.quantity}  order_id: ${order.order_id}`);

    } catch (err) {
      logger.error(`❌ Failed to cancel order for ${order.tradingsymbol}`, {
        order_id: order.order_id,
        error:    err.message,
      });
    }
  }
}

// ── One guard cycle ───────────────────────────────────────────────────────────

async function runGuardCycle(kite, basketSymbols) {
  if (!isMarketHours()) {
    logger.debug('Circuit guard: market closed, skipping cycle');
    return;
  }

  try {
    const openBuyOrders = await getOpenBuyOrders(kite, basketSymbols);

    if (openBuyOrders.length === 0) {
      logger.debug('Circuit guard: no open BUY orders to watch');
      return;
    }

    logger.debug(`🛡️  Circuit guard: checking ${openBuyOrders.length} open BUY order(s)…`);
    await checkAndCancelIfLowerCircuit(kite, openBuyOrders);

  } catch (err) {
    // Don't crash the guard loop on a single failed cycle
    logger.warn('🛡️  Circuit guard cycle error', { error: err.message });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function startCircuitGuard() {
  logger.info('');
  logger.info('🛡️  Starting lower circuit guard…');
  logger.info(`   Auto-cancel on lower circuit : ${AUTO_CANCEL ? '🔴 ENABLED' : '🟡 DISABLED (log only)'}`);
  logger.info(`   Check interval               : every ${GUARD_INTERVAL / 1000}s`);

  // Load basket to know which symbols we care about
  let basket;
  try {
    basket = loadBasket();
  } catch (err) {
    logger.warn(`⚠️  Circuit guard: could not load basket.json – ${err.message}`);
    logger.warn('   Circuit guard will NOT run. (No basket symbols to watch.)');
    return;
  }

  const basketSymbols = new Set(basket.orders.map((o) => o.tradingsymbol));
  logger.info(`   Watching symbols: ${[...basketSymbols].join(', ')}`);

  const kite = getKiteClient();

  // Run first check immediately, then on interval
  await runGuardCycle(kite, basketSymbols);

  setInterval(() => runGuardCycle(kite, basketSymbols), GUARD_INTERVAL);

  logger.info('🛡️  Circuit guard is active.');
}

module.exports = { startCircuitGuard };
