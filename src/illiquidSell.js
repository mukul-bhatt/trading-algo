'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const { getKiteClient } = require('./login');
const { retry, formatCurrency, isDryRun } = require('./utils');

let preparedOrders = [];

/**
 * Prepares the illiquid sell orders by fetching holdings and lower circuit limits.
 * This runs at 9:29 AM, 1 minute before the call auction placement time.
 */
async function prepareIlliquidOrders() {
  const stocksEnv = process.env.ILLIQUID_SELL_STOCKS;
  if (!stocksEnv) return;

  const targetStocks = stocksEnv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (targetStocks.length === 0) return;

  logger.info(`⏰ Preparing illiquid sell orders for: ${targetStocks.join(', ')}`);
  
  try {
    const kite = getKiteClient();
    if (!kite) {
      logger.error('❌ Kite client not available for illiquid sell prep.');
      return;
    }

    // 1. Fetch Holdings
    const holdings = await retry(() => kite.getHoldings(), { maxAttempts: 3, label: 'getHoldings:illiquid' });
    const heldTargets = holdings.filter(h => targetStocks.includes(h.tradingsymbol));

    if (heldTargets.length === 0) {
      logger.info('ℹ️ None of the target illiquid stocks are currently in your holdings.');
      preparedOrders = [];
      return;
    }

    // 2. Fetch quotes to get the lower circuit limit for LIMIT orders
    // We use NSE prefix assuming these are NSE stocks (T2T/ESM). 
    // It's safer to map exchange from the holding itself.
    const instruments = heldTargets.map(h => `${h.exchange}:${h.tradingsymbol}`);
    const quotes = await retry(() => kite.getQuote(instruments), { maxAttempts: 3, label: 'getQuote:illiquid' });

    preparedOrders = heldTargets.map(holding => {
      const instrument = `${holding.exchange}:${holding.tradingsymbol}`;
      const quote = quotes[instrument];
      
      // If we couldn't fetch a lower circuit, we fallback to 0 (which might fail, or we can use market order, 
      // but usually lower circuit is available). Let's fallback to current close or LTP - 10%.
      let sellPrice = quote ? quote.lower_circuit_limit : 0;
      if (!sellPrice && quote) sellPrice = quote.last_price;

      return {
        tradingsymbol: holding.tradingsymbol,
        exchange: holding.exchange,
        transaction_type: 'SELL',
        quantity: holding.quantity,
        order_type: 'LIMIT',
        product: 'CNC',
        price: sellPrice,
        validity: 'DAY',
        tag: 'ILLIQUID_SELL',
      };
    });

    logger.info(`✅ Prepared ${preparedOrders.length} illiquid sell order(s) for 9:30 AM execution.`);
    preparedOrders.forEach(o => {
      logger.info(`   → SELL ${o.quantity}x ${o.tradingsymbol} LIMIT @ ${formatCurrency(o.price)}`);
    });

  } catch (err) {
    logger.error('❌ Failed to prepare illiquid orders', { error: err.message });
    preparedOrders = [];
  }
}

/**
 * Fires at exactly 9:30 AM, waits 200ms, and places the prepared orders.
 */
async function executeIlliquidOrders() {
  if (preparedOrders.length === 0) return;

  const DELAY_MS = 200;
  logger.info(`⏰ It's 9:30 AM. Waiting ${DELAY_MS}ms before firing illiquid sell orders...`);
  
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));

  const kite = getKiteClient();
  
  logger.info(`🚀 Firing ${preparedOrders.length} illiquid sell order(s) NOW!`);

  for (const params of preparedOrders) {
    if (isDryRun()) {
      logger.warn(`🧪 [DRY RUN] Would place: SELL ${params.quantity}x ${params.tradingsymbol} LIMIT @ ${params.price}`);
      continue;
    }

    try {
      const orderId = await kite.placeOrder('regular', params);
      logger.warn(`✅ ILLIQUID SELL PLACED: ${params.tradingsymbol}  qty:${params.quantity}  price:${params.price}  order_id:${orderId}`);
    } catch (err) {
      logger.error(`❌ ILLIQUID SELL FAILED for ${params.tradingsymbol}`, { error: err.message });
    }
  }

  // Clear orders after execution so they don't fire again
  preparedOrders = [];
}

/**
 * Starts the cron jobs for illiquid call auction selling.
 */
function scheduleIlliquidSell() {
  const stocksEnv = process.env.ILLIQUID_SELL_STOCKS;
  if (!stocksEnv || stocksEnv.trim() === '') {
    return; // Disabled
  }

  logger.info(`🕐 Illiquid Sell schedule: Prep at 09:29:00, Execute at 09:30:00.200 (weekdays)`);
  logger.info(`   Targets: ${stocksEnv}`);

  // Prepare at 9:29 AM
  cron.schedule('29 9 * * 1-5', () => {
    prepareIlliquidOrders();
  }, { timezone: 'Asia/Kolkata' });

  // Execute at 9:30 AM
  cron.schedule('30 9 * * 1-5', () => {
    executeIlliquidOrders();
  }, { timezone: 'Asia/Kolkata' });
}

module.exports = {
  scheduleIlliquidSell,
  prepareIlliquidOrders, // Exported for manual testing
  executeIlliquidOrders  // Exported for manual testing
};
