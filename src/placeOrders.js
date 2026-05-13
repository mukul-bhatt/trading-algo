/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/placeOrders.js  –  Basket Order Placement Engine
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE DOES:
 * ─────────────────────
 * 1. Reads the basket from config/basket.json
 * 2. Validates every order in the basket (catches mistakes BEFORE hitting the API)
 * 3. Places each order via the Kite Connect API, one by one
 * 4. Tracks which orders have already been placed today (deduplication)
 * 5. Supports DRY_RUN mode – logs what it would do without placing anything real
 *
 * KEY CONCEPTS EXPLAINED:
 * ────────────────────────
 * • CNC  (Cash and Carry) – Delivery order.  You actually hold the shares in
 *   your demat account.  Suitable for investments held longer than one day.
 *
 * • MARKET order – "Buy/sell immediately at the best available price."
 *   Fast but you don't control the exact price.
 *
 * • LIMIT order  – "Buy/sell only if the price reaches MY price or better."
 *   You control the price but the order might not execute if price never reaches it.
 *
 * • Tag – A custom string you attach to an order (up to 20 chars).
 *   Helps you identify your bot's orders on the Kite UI and in order history.
 *
 * DEDUPLICATION:
 * ──────────────
 * To avoid placing the same basket twice (e.g. if the script crashes and
 * restarts), we save a "placed orders" log to logs/placed-YYYY-MM-DD.json.
 * Before placing, we check if the same symbol+quantity combo is already there.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const logger               = require('./logger');
const { retry, isDryRun, formatCurrency } = require('./utils');
const { getKiteClient }    = require('./login');

// ── Paths ─────────────────────────────────────────────────────────────────────
const BASKET_PATH = path.join(__dirname, '..', 'config', 'basket.json');
const LOGS_DIR    = path.join(__dirname, '..', 'logs');

// ─────────────────────────────────────────────────────────────────────────────
// loadBasket()
// ─────────────────────────────────────────────────────────────────────────────
// Reads and parses config/basket.json.
// Throws a descriptive error if the file is missing or malformed.
//
function loadBasket() {
  if (!fs.existsSync(BASKET_PATH)) {
    throw new Error(
      `Basket file not found: ${BASKET_PATH}\n` +
      'Create it by copying the example: cp config/basket.json.example config/basket.json'
    );
  }

  let basket;
  try {
    basket = JSON.parse(fs.readFileSync(BASKET_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `basket.json contains invalid JSON: ${err.message}\n` +
      'Use a JSON validator: https://jsonlint.com/'
    );
  }

  if (!Array.isArray(basket.orders) || basket.orders.length === 0) {
    throw new Error('basket.json must have an "orders" array with at least one order.');
  }

  logger.info(`📂 Loaded basket: "${basket.basketName}" (${basket.orders.length} orders)`);
  return basket;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateOrder(order, index)
// ─────────────────────────────────────────────────────────────────────────────
// Validates a single order object from the basket.
// Returns an array of error strings (empty array = valid).
//
// WHY VALIDATE BEFORE HITTING THE API?
//   The Kite API will also return errors for bad orders, but:
//   • API errors cost you a round-trip network request
//   • The error messages can be cryptic
//   • Validating locally means you catch ALL problems at once, upfront
//
function validateOrder(order, index) {
  const errors = [];
  const pos    = `Order[${index}] (${order.tradingsymbol || 'unknown'})`;

  // Required fields
  if (!order.tradingsymbol)      errors.push(`${pos}: "tradingsymbol" is required`);
  if (!order.exchange)           errors.push(`${pos}: "exchange" is required`);
  if (!order.transaction_type)   errors.push(`${pos}: "transaction_type" is required`);
  if (!order.quantity)           errors.push(`${pos}: "quantity" is required`);
  if (!order.product)            errors.push(`${pos}: "product" is required`);
  if (!order.order_type)         errors.push(`${pos}: "order_type" is required`);

  // Valid values check
  const VALID_EXCHANGES         = ['NSE', 'BSE', 'NFO', 'MCX', 'BFO'];
  const VALID_TRANSACTION_TYPES = ['BUY', 'SELL'];
  const VALID_PRODUCTS          = ['CNC', 'MIS', 'NRML'];
  const VALID_ORDER_TYPES       = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  const VALID_VALIDITIES        = ['DAY', 'IOC', 'TTL'];

  if (order.exchange && !VALID_EXCHANGES.includes(order.exchange))
    errors.push(`${pos}: exchange must be one of ${VALID_EXCHANGES.join(', ')}`);

  if (order.transaction_type && !VALID_TRANSACTION_TYPES.includes(order.transaction_type))
    errors.push(`${pos}: transaction_type must be BUY or SELL`);

  if (order.product && !VALID_PRODUCTS.includes(order.product))
    errors.push(`${pos}: product must be one of ${VALID_PRODUCTS.join(', ')}`);

  if (order.order_type && !VALID_ORDER_TYPES.includes(order.order_type))
    errors.push(`${pos}: order_type must be one of ${VALID_ORDER_TYPES.join(', ')}`);

  if (order.validity && !VALID_VALIDITIES.includes(order.validity))
    errors.push(`${pos}: validity must be one of ${VALID_VALIDITIES.join(', ')}`);

  // Quantity must be a positive integer
  if (order.quantity && (!Number.isInteger(order.quantity) || order.quantity <= 0))
    errors.push(`${pos}: quantity must be a positive integer`);

  // LIMIT orders must have a price — UNLESS "use_ltp: true" is set.
  // use_ltp is only valid for SELL orders (fetches live price at order time).
  // Useful when you know you want to sell but don't know tomorrow's exact price.
  if (order.order_type === 'LIMIT' && !order.use_ltp && (!order.price || order.price <= 0))
    errors.push(`${pos}: LIMIT orders must have a positive "price" (or set "use_ltp": true for SELL orders)`);

  // MARKET orders should NOT have a price (it is ignored but warns the user)
  if (order.order_type === 'MARKET' && order.price)
    logger.warn(`${pos}: MARKET order has a "price" – it will be ignored by the exchange`);

  // Tag must be ≤ 20 chars (Kite's limit)
  if (order.tag && order.tag.length > 20)
    errors.push(`${pos}: "tag" must be 20 characters or fewer (yours is ${order.tag.length})`);

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateBasket(basket)
// ─────────────────────────────────────────────────────────────────────────────
// Validates all orders. Throws if any are invalid.
//
function validateBasket(basket) {
  logger.info('🔍 Validating basket…');

  const allErrors = [];
  basket.orders.forEach((order, i) => {
    const errors = validateOrder(order, i + 1);
    allErrors.push(...errors);
  });

  if (allErrors.length > 0) {
    logger.error(`❌ Basket has ${allErrors.length} validation error(s):`);
    allErrors.forEach((e) => logger.error(`   • ${e}`));
    throw new Error('Basket validation failed. Fix the errors above in config/basket.json');
  }

  logger.info('✅ All orders passed validation');
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication helpers
// ─────────────────────────────────────────────────────────────────────────────
// We keep a per-day file (logs/placed-YYYY-MM-DD.json) listing every order
// we have already placed.  Before placing, we check this file.
//
function getPlacedLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `placed-${date}.json`);
}

function loadPlacedOrders() {
  const logPath = getPlacedLogPath();
  if (!fs.existsSync(logPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch {
    return [];
  }
}

function recordPlacedOrder(orderParams, orderId) {
  const logPath    = getPlacedLogPath();
  const existing   = loadPlacedOrders();
  existing.push({
    order_id:       orderId,
    tradingsymbol:  orderParams.tradingsymbol,
    exchange:       orderParams.exchange,
    transaction_type: orderParams.transaction_type,
    quantity:       orderParams.quantity,
    order_type:     orderParams.order_type,
    price:          orderParams.price,
    placed_at:      new Date().toISOString(),
  });
  fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
}

function isDuplicate(order) {
  const placed = loadPlacedOrders();
  return placed.some(
    (p) =>
      p.tradingsymbol     === order.tradingsymbol &&
      p.exchange          === order.exchange &&
      p.transaction_type  === order.transaction_type &&
      p.quantity          === order.quantity
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// placeSingleOrder(kite, order)
// ─────────────────────────────────────────────────────────────────────────────
// Places ONE order via the API (or logs it in dry-run mode).
// Returns the order ID string (or "DRY-RUN" in paper mode).
//
async function placeSingleOrder(kite, order) {
  let resolvedOrder = { ...order };

  // ── use_ltp: fetch live price at order time ───────────────────────────────
  // When "use_ltp": true is set in basket.json, we fetch the current LTP
  // and use it as the LIMIT price.  Designed for SELL orders where you want
  // to exit at market price but still use a LIMIT order (safer than MARKET
  // for illiquid penny/T2T stocks).
  //
  // Example basket.json entry:
  //   {
  //     "tradingsymbol": "XYZSTOCK",
  //     "exchange": "BSE",
  //     "transaction_type": "SELL",
  //     "quantity": 100,
  //     "product": "CNC",
  //     "order_type": "LIMIT",
  //     "use_ltp": true          ← price will be fetched live
  //   }
  if (resolvedOrder.use_ltp) {
    const key = `${resolvedOrder.exchange}:${resolvedOrder.tradingsymbol}`;
    logger.info(`🔍 Fetching LTP for ${key} (use_ltp=true)…`);
    try {
      const ltpData = await retry(
        () => kite.getLTP([key]),
        { maxAttempts: 3, label: `getLTP:${resolvedOrder.tradingsymbol}` }
      );
      const ltp = ltpData[key]?.last_price;
      if (!ltp || ltp <= 0) {
        throw new Error(`LTP returned ${ltp} for ${key} – cannot place order`);
      }
      resolvedOrder.price = ltp;
      logger.info(`   LTP resolved: ${formatCurrency(ltp)} for ${resolvedOrder.tradingsymbol}`);
    } catch (err) {
      throw new Error(`use_ltp fetch failed for ${resolvedOrder.tradingsymbol}: ${err.message}`);
    }
  }

  // Build the params object that Kite expects
  // Only include "price" for LIMIT orders; omit it for MARKET orders
  const params = {
    tradingsymbol:    resolvedOrder.tradingsymbol,
    exchange:         resolvedOrder.exchange,
    transaction_type: resolvedOrder.transaction_type,
    quantity:         resolvedOrder.quantity,
    product:          resolvedOrder.product,
    order_type:       resolvedOrder.order_type,
    validity:         resolvedOrder.validity || 'DAY',
    ...(resolvedOrder.tag   && { tag:   resolvedOrder.tag }),
    ...(resolvedOrder.price && resolvedOrder.order_type !== 'MARKET' && { price: resolvedOrder.price }),
  };

  const label = `${resolvedOrder.transaction_type} ${resolvedOrder.quantity}x ${resolvedOrder.tradingsymbol} [${resolvedOrder.order_type}${resolvedOrder.use_ltp ? ' @ LTP' : ''}]`;

  if (isDryRun()) {
    // ── DRY RUN: just log, don't actually call the API ─────────────────────
    logger.info(`🧪 [DRY RUN] Would place order: ${label}`, {
      price: resolvedOrder.price ? formatCurrency(resolvedOrder.price) : 'MARKET PRICE',
      params,
    });
    return 'DRY-RUN';
  }

  // ── LIVE: call the API with retry logic ───────────────────────────────────
  const orderId = await retry(
    () => kite.placeOrder('regular', params),
    { maxAttempts: 3, label }
  );

  logger.info(`✅ Order placed: ${label}`, { order_id: orderId });
  return orderId;
}

// ─────────────────────────────────────────────────────────────────────────────
// placeBasketOrders()
// ─────────────────────────────────────────────────────────────────────────────
// Main exported function.  Loads, validates, and places all basket orders.
//
async function placeBasketOrders() {
  logger.info('══════════════════════════════════════════════════════');
  logger.info('  BASKET ORDER PLACEMENT STARTING');
  if (isDryRun()) logger.info('  ⚠️  DRY RUN MODE – no real orders will be placed');
  logger.info('══════════════════════════════════════════════════════');

  // 1. Load the basket
  const basket = loadBasket();

  // 2. Validate all orders – abort if anything is wrong
  validateBasket(basket);

  // 3. Connect to Kite (reads saved session)
  const kite = getKiteClient();

  // 4. Place each order
  const results = [];

  for (const [i, order] of basket.orders.entries()) {
    const label = `${order.tradingsymbol} ${order.transaction_type} ${order.quantity}`;
    logger.info(`─── Processing order ${i + 1}/${basket.orders.length}: ${label}`);

    // ── Deduplication check ─────────────────────────────────────────────────
    if (isDuplicate(order)) {
      logger.warn(`⚠️  Skipping duplicate: ${label} was already placed today`);
      results.push({ ...order, order_id: 'SKIPPED-DUPLICATE', status: 'skipped' });
      continue;
    }

    // ── Place the order ─────────────────────────────────────────────────────
    try {
      const orderId = await placeSingleOrder(kite, order);

      // Record in today's placed-orders log (for deduplication)
      if (!isDryRun()) {
        recordPlacedOrder(order, orderId);
      }

      results.push({ ...order, order_id: orderId, status: 'placed' });

      // Small delay between orders to avoid rate-limiting
      // Kite allows ~3 requests/second; 500ms keeps us well within limits
      if (i < basket.orders.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }

    } catch (err) {
      const errMsg = err?.response?.data?.message || err.message;
      logger.error(`❌ Failed to place order: ${label}`, { error: errMsg });
      results.push({ ...order, order_id: null, status: 'failed', error: errMsg });
    }
  }

  // 5. Summary report
  const placed  = results.filter((r) => r.status === 'placed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed  = results.filter((r) => r.status === 'failed').length;

  logger.info('══════════════════════════════════════════════════════');
  logger.info(`  BASKET COMPLETE: ${placed} placed | ${skipped} skipped | ${failed} failed`);
  logger.info('══════════════════════════════════════════════════════');

  return results;
}

module.exports = { placeBasketOrders, loadBasket, validateBasket };
