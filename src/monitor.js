/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/monitor.js  –  Live Position & Holdings Monitor
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS DOES:
 * ───────────────
 * After orders are placed, this module polls the Kite API at regular intervals
 * and reports:
 *   • Open positions (intraday/overnight) with live PnL
 *   • Holdings (long-term CNC positions) with current value
 *   • Today's order statuses (COMPLETE, OPEN, REJECTED, etc.)
 *
 * POLLING vs WEBSOCKET:
 * ──────────────────────
 * Polling = "ask the server every N seconds for fresh data" (simple, REST API)
 * Websocket = "server pushes data to you the moment it changes" (fast, real-time)
 *
 * This module uses POLLING (simpler to understand).
 * websocket.js (coming in Phase 2) will handle real-time tick data.
 *
 * INTERVAL:
 * ─────────
 * We poll every 5 seconds.  Kite's rate limit is 3 req/s per endpoint.
 * With 3 API calls per cycle (positions, holdings, orders) at 5-second intervals,
 * we are well within limits.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger                      = require('./logger');
const { getKiteClient }           = require('./login');
const { retry, formatCurrency, isMarketHours } = require('./utils');

// How often to poll (in milliseconds).  5000 = 5 seconds.
const POLL_INTERVAL_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// fetchPositions(kite)
// ─────────────────────────────────────────────────────────────────────────────
// Gets your open positions (intraday buy/sell, F&O, etc.)
//
// Kite returns two arrays:
//   net  – net position (long - short)
//   day  – all positions opened today
//
async function fetchPositions(kite) {
  const data = await retry(
    () => kite.getPositions(),
    { maxAttempts: 3, label: 'getPositions' }
  );

  const positions = data.net.filter((p) => p.quantity !== 0);

  if (positions.length === 0) {
    logger.info('📊 Positions: none open');
    return;
  }

  logger.info(`📊 Open Positions (${positions.length}):`);
  positions.forEach((p) => {
    const pnl     = p.pnl;
    const pnlStr  = formatCurrency(pnl);
    const emoji   = pnl >= 0 ? '🟢' : '🔴';
    logger.info(
      `   ${emoji} ${p.tradingsymbol.padEnd(15)} qty: ${String(p.quantity).padStart(5)}  ` +
      `avg: ${formatCurrency(p.average_price)}  LTP: ${formatCurrency(p.last_price)}  ` +
      `PnL: ${pnlStr}`
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchHoldings(kite)
// ─────────────────────────────────────────────────────────────────────────────
// Gets your CNC holdings (shares you hold in your demat account from past days).
//
async function fetchHoldings(kite) {
  const holdings = await retry(
    () => kite.getHoldings(),
    { maxAttempts: 3, label: 'getHoldings' }
  );

  if (holdings.length === 0) {
    logger.info('📁 Holdings: none');
    return;
  }

  const totalValue = holdings.reduce((sum, h) => sum + h.last_price * h.quantity, 0);
  const totalPnL   = holdings.reduce((sum, h) => sum + h.pnl, 0);
  const emoji      = totalPnL >= 0 ? '🟢' : '🔴';

  logger.info(`📁 Holdings (${holdings.length} stocks):`);
  holdings.forEach((h) => {
    const pnl = h.pnl;
    const e   = pnl >= 0 ? '🟢' : '🔴';
    logger.info(
      `   ${e} ${h.tradingsymbol.padEnd(15)} qty: ${String(h.quantity).padStart(5)}  ` +
      `avg: ${formatCurrency(h.average_price)}  LTP: ${formatCurrency(h.last_price)}  ` +
      `PnL: ${formatCurrency(pnl)}`
    );
  });

  logger.info(`   ${emoji} Portfolio value: ${formatCurrency(totalValue)}  Total PnL: ${formatCurrency(totalPnL)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchOrders(kite)
// ─────────────────────────────────────────────────────────────────────────────
// Gets today's order history and logs status of each.
//
async function fetchOrders(kite) {
  const orders = await retry(
    () => kite.getOrders(),
    { maxAttempts: 3, label: 'getOrders' }
  );

  if (orders.length === 0) {
    logger.info('📋 Orders: none placed today');
    return;
  }

  // Group by status for a clean summary
  const statusCounts = {};
  orders.forEach((o) => {
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  });

  const summary = Object.entries(statusCounts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(' | ');

  logger.info(`📋 Orders today: ${orders.length} total  [${summary}]`);

  // Show any rejected orders with reasons (important!)
  const rejected = orders.filter((o) => o.status === 'REJECTED');
  rejected.forEach((o) => {
    logger.warn(`   ⚠️  REJECTED: ${o.tradingsymbol} – Reason: ${o.status_message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runMonitorCycle(kite)
// ─────────────────────────────────────────────────────────────────────────────
// Runs one complete monitoring cycle (positions + holdings + orders).
//
async function runMonitorCycle(kite) {
  const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ${now} IST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await fetchPositions(kite);
  await fetchHoldings(kite);
  await fetchOrders(kite);
}

// ─────────────────────────────────────────────────────────────────────────────
// startMonitor()
// ─────────────────────────────────────────────────────────────────────────────
// Exported function: starts the polling loop.
// Runs indefinitely until you press Ctrl+C.
//
async function startMonitor() {
  logger.info('🔭 Starting monitor…  (Press Ctrl+C to stop)');

  const kite = getKiteClient();

  // Run first cycle immediately, then every POLL_INTERVAL_MS
  const runLoop = async () => {
    try {
      if (!isMarketHours()) {
        logger.info('⏰ Market is currently CLOSED.  Monitoring paused.');
      } else {
        await runMonitorCycle(kite);
      }
    } catch (err) {
      // Don't crash the whole monitor for a single failed cycle
      logger.error('Monitor cycle error', { error: err.message });
    }

    // Schedule next cycle
    setTimeout(runLoop, POLL_INTERVAL_MS);
  };

  await runLoop();
}

module.exports = { startMonitor, fetchPositions, fetchHoldings, fetchOrders };
