/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/pcaOrders.js  –  Periodic Call Auction (PCA) Basket Order Engine
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS PERIODIC CALL AUCTION (PCA)?
 * ─────────────────────────────────────
 * NSE moves certain illiquid, recently-revived, or circuit-hit stocks out of
 * continuous trading and into a series of timed "call auctions."
 *
 * Each auction session has a fixed schedule:
 *
 *   Session 1  →  9:30 AM – 10:15 AM  (45-min auction window)
 *   Buffer     →  10:15 AM – 10:30 AM  (15-min post-session buffer)
 *   Session 2  →  10:30 AM – 11:15 AM
 *   Buffer     →  11:15 AM – 11:30 AM
 *   Session 3  →  11:30 AM – 12:15 PM
 *   … and so on through the trading day.
 *
 * WHY SEPARATE FROM basket.json?
 * ────────────────────────────────
 * Regular basket orders (basket.json) are placed at 9:00 AM during the NSE
 * pre-open session, which does NOT apply to PCA stocks.  Mixing PCA stocks
 * into the regular basket would result in ORDER REJECTION by the exchange.
 *
 * This module uses its own config file (config/pca_basket.json) and fires
 * at 9:30:00 AM — the exact moment Session 1 begins accepting orders.
 *
 * KEY RESTRICTIONS IN PCA MODE:
 * ───────────────────────────────
 *   • Only LIMIT orders are accepted.  MARKET orders are REJECTED.
 *   • Only CNC product is relevant (T2T/illiquid stocks are delivery-only).
 *   • Exchange is configurable per order (NSE or BSE) in pca_basket.json.
 *
 * DEDUPLICATION:
 * ───────────────
 * Uses a separate placed log: logs/placed-pca-YYYY-MM-DD.json
 * This prevents double-firing if the scheduler somehow fires twice.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const logger            = require('./logger');
const { retry, isDryRun, formatCurrency } = require('./utils');
const { getKiteClient } = require('./login');

// ── Paths ──────────────────────────────────────────────────────────────────────
const PCA_BASKET_PATH = path.join(__dirname, '..', 'config', 'pca_basket.json');
const LOGS_DIR        = path.join(__dirname, '..', 'logs');

// ── PCA session reference (informational) ─────────────────────────────────────
//
// Session 1 : 9:30 AM – 10:15 AM  (orders placed at exactly 9:30:00 AM)
// Buffer    : 10:15 AM – 10:30 AM
// Session 2 : 10:30 AM – 11:15 AM
// … (45-min windows + 15-min buffers)
//
// This module targets Session 1 only.  Future sessions can be added by
// duplicating the scheduler with the appropriate cron expression.

// ─────────────────────────────────────────────────────────────────────────────
// loadPcaBasket()
// ─────────────────────────────────────────────────────────────────────────────
// Reads and parses config/pca_basket.json.
//
function loadPcaBasket() {
  if (!fs.existsSync(PCA_BASKET_PATH)) {
    throw new Error(
      `PCA basket file not found: ${PCA_BASKET_PATH}\n` +
      'Create it at config/pca_basket.json (see existing file for format).'
    );
  }

  let basket;
  try {
    basket = JSON.parse(fs.readFileSync(PCA_BASKET_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `pca_basket.json contains invalid JSON: ${err.message}\n` +
      'Use a JSON validator: https://jsonlint.com/'
    );
  }

  // Strip any _comment fields (they are documentation, not real orders)
  if (Array.isArray(basket.orders)) {
    basket.orders = basket.orders.map((o) => {
      const clean = { ...o };
      delete clean._comment;
      return clean;
    });
  }

  if (!Array.isArray(basket.orders) || basket.orders.length === 0) {
    throw new Error('pca_basket.json must have an "orders" array with at least one order.');
  }

  logger.info(`📂 Loaded PCA basket: "${basket.basketName}" (${basket.orders.length} order(s))`);
  return basket;
}

// ─────────────────────────────────────────────────────────────────────────────
// validatePcaOrder(order, index)
// ─────────────────────────────────────────────────────────────────────────────
// Validates a single PCA order.  Enforces PCA-specific rules ON TOP OF the
// standard field checks.
//
function validatePcaOrder(order, index) {
  const errors = [];
  const pos    = `PCA Order[${index}] (${order.tradingsymbol || 'unknown'})`;

  // ── Standard required fields ──────────────────────────────────────────────
  if (!order.tradingsymbol)     errors.push(`${pos}: "tradingsymbol" is required`);
  if (!order.exchange)          errors.push(`${pos}: "exchange" is required`);
  if (!order.transaction_type)  errors.push(`${pos}: "transaction_type" is required`);
  if (!order.quantity)          errors.push(`${pos}: "quantity" is required`);
  if (!order.product)           errors.push(`${pos}: "product" is required`);
  if (!order.order_type)        errors.push(`${pos}: "order_type" is required`);

  // ── Valid values ──────────────────────────────────────────────────────────
  const VALID_EXCHANGES         = ['NSE', 'BSE'];    // PCA is NSE/BSE only
  const VALID_TRANSACTION_TYPES = ['BUY', 'SELL'];
  const VALID_PRODUCTS          = ['CNC', 'MIS', 'NRML'];
  const VALID_VALIDITIES        = ['DAY', 'IOC', 'TTL'];

  if (order.exchange && !VALID_EXCHANGES.includes(order.exchange))
    errors.push(`${pos}: exchange must be NSE or BSE for PCA stocks (got "${order.exchange}")`);

  if (order.transaction_type && !VALID_TRANSACTION_TYPES.includes(order.transaction_type))
    errors.push(`${pos}: transaction_type must be BUY or SELL`);

  if (order.product && !VALID_PRODUCTS.includes(order.product))
    errors.push(`${pos}: product must be CNC, MIS, or NRML`);

  if (order.validity && !VALID_VALIDITIES.includes(order.validity))
    errors.push(`${pos}: validity must be DAY, IOC, or TTL`);

  if (order.quantity && (!Number.isInteger(order.quantity) || order.quantity <= 0))
    errors.push(`${pos}: quantity must be a positive integer`);

  if (order.tag && order.tag.length > 20)
    errors.push(`${pos}: "tag" must be ≤ 20 characters (yours: ${order.tag.length})`);

  // ── PCA-SPECIFIC: MARKET orders are FORBIDDEN ─────────────────────────────
  //
  // During a call auction the exchange collects all orders and determines a
  // single clearing price.  MARKET orders have no defined price and are
  // therefore REJECTED by the exchange in PCA mode.
  //
  // You MUST use LIMIT orders in pca_basket.json.
  if (order.order_type === 'MARKET') {
    errors.push(
      `${pos}: MARKET orders are NOT allowed in Periodic Call Auction mode.\n` +
      '   Use "order_type": "LIMIT" and specify a "price".'
    );
  }

  // ── LIMIT price check ─────────────────────────────────────────────────────
  if (order.order_type === 'LIMIT' && (!order.price || order.price <= 0))
    errors.push(`${pos}: LIMIT orders must have a positive "price"`);

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// validatePcaBasket(basket)
// ─────────────────────────────────────────────────────────────────────────────
function validatePcaBasket(basket) {
  logger.info('🔍 Validating PCA basket…');

  const allErrors = [];
  basket.orders.forEach((order, i) => {
    const errors = validatePcaOrder(order, i + 1);
    allErrors.push(...errors);
  });

  if (allErrors.length > 0) {
    logger.error(`❌ PCA basket has ${allErrors.length} validation error(s):`);
    allErrors.forEach((e) => logger.error(`   • ${e}`));
    throw new Error('PCA basket validation failed. Fix the errors above in config/pca_basket.json');
  }

  logger.info('✅ All PCA orders passed validation');
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication helpers (separate file from the regular basket)
// ─────────────────────────────────────────────────────────────────────────────
function getPcaPlacedLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `placed-pca-${date}.json`);
}

function loadPcaPlacedOrders() {
  const logPath = getPcaPlacedLogPath();
  if (!fs.existsSync(logPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch {
    return [];
  }
}

function recordPcaPlacedOrder(orderParams, orderId) {
  const logPath  = getPcaPlacedLogPath();
  const existing = loadPcaPlacedOrders();
  existing.push({
    order_id:         orderId,
    tradingsymbol:    orderParams.tradingsymbol,
    exchange:         orderParams.exchange,
    transaction_type: orderParams.transaction_type,
    quantity:         orderParams.quantity,
    order_type:       orderParams.order_type,
    price:            orderParams.price,
    placed_at:        new Date().toISOString(),
    session:          'PCA-S1',
  });
  fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
}

function isPcaDuplicate(order) {
  const placed = loadPcaPlacedOrders();
  return placed.some(
    (p) =>
      p.tradingsymbol     === order.tradingsymbol &&
      p.exchange          === order.exchange &&
      p.transaction_type  === order.transaction_type &&
      p.quantity          === order.quantity
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// placeSinglePcaOrder(kite, order)
// ─────────────────────────────────────────────────────────────────────────────
// Places one PCA order via the API (or logs it in dry-run mode).
//
async function placeSinglePcaOrder(kite, order) {
  const params = {
    tradingsymbol:    order.tradingsymbol,
    exchange:         order.exchange,
    transaction_type: order.transaction_type,
    quantity:         order.quantity,
    product:          order.product,
    order_type:       order.order_type,
    price:            order.price,
    validity:         order.validity || 'DAY',
    ...(order.tag && { tag: order.tag }),
  };

  const label = `${order.transaction_type} ${order.quantity}x ${order.tradingsymbol} ` +
                `[${order.exchange} LIMIT @ ${formatCurrency(order.price)}]`;

  if (isDryRun()) {
    logger.info(`🧪 [DRY RUN] Would place PCA order: ${label}`, { params });
    return 'DRY-RUN';
  }

  const orderId = await retry(
    () => kite.placeOrder('regular', params),
    { maxAttempts: 3, label: `pca:${order.tradingsymbol}` }
  );

  logger.warn(`✅ PCA ORDER PLACED: ${label}  order_id:${orderId}`);
  return orderId;
}

// ─────────────────────────────────────────────────────────────────────────────
// placePcaBasketOrders()
// ─────────────────────────────────────────────────────────────────────────────
// Main exported function.  Loads, validates, and places all PCA basket orders.
// Designed to be called at exactly 9:30:00 AM IST for Session 1.
//
async function placePcaBasketOrders() {
  logger.info('══════════════════════════════════════════════════════');
  logger.info('  📢 PCA (PERIODIC CALL AUCTION) BASKET – SESSION 1');
  logger.info('  Orders fire at 9:30 AM when Session 1 opens');
  if (isDryRun()) logger.info('  ⚠️  DRY RUN MODE – no real orders will be placed');
  logger.info('══════════════════════════════════════════════════════');

  // 1. Load basket
  const basket = loadPcaBasket();

  // 2. Validate – abort if anything is wrong
  validatePcaBasket(basket);

  // 3. Get Kite client
  const kite = getKiteClient();

  // 4. Place each order
  const results = [];

  for (const [i, order] of basket.orders.entries()) {
    const label = `${order.tradingsymbol} ${order.transaction_type} ${order.quantity}`;
    logger.info(`─── PCA order ${i + 1}/${basket.orders.length}: ${label}`);

    // Deduplication check
    if (isPcaDuplicate(order)) {
      logger.warn(`⚠️  Skipping duplicate PCA order: ${label} was already placed today`);
      results.push({ ...order, order_id: 'SKIPPED-DUPLICATE', status: 'skipped' });
      continue;
    }

    try {
      const orderId = await placeSinglePcaOrder(kite, order);

      if (!isDryRun()) {
        recordPcaPlacedOrder(order, orderId);
      }

      results.push({ ...order, order_id: orderId, status: 'placed' });

      // Small delay between orders to stay within Kite rate limits
      if (i < basket.orders.length - 1) {
        await new Promise((r) => setTimeout(r, 350));
      }

    } catch (err) {
      const errMsg = err?.response?.data?.message || err.message;
      logger.error(`❌ Failed to place PCA order: ${label}`, { error: errMsg });
      results.push({ ...order, order_id: null, status: 'failed', error: errMsg });
    }
  }

  // 5. Summary
  const placed  = results.filter((r) => r.status === 'placed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed  = results.filter((r) => r.status === 'failed').length;

  logger.info('══════════════════════════════════════════════════════');
  logger.info(`  PCA BASKET COMPLETE: ${placed} placed | ${skipped} skipped | ${failed} failed`);
  logger.info('══════════════════════════════════════════════════════');

  return results;
}

module.exports = { placePcaBasketOrders, loadPcaBasket, validatePcaBasket };
