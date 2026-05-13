/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/websocket.js  –  Kite Ticker (Real-time WebSocket Price Feed)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS A WEBSOCKET?
 * ─────────────────────
 * A normal HTTP request is one-way: you ask → server responds → connection closes.
 * A WebSocket is a persistent, two-way connection:
 *   - You connect once
 *   - The server sends you data continuously, the moment something changes
 *   - Much faster and more efficient than polling for fast-moving data like prices
 *
 * KITE TICKER:
 * ─────────────
 * Kite Connect provides a WebSocket API called "KiteTicker".
 * Once connected, you subscribe to instruments by their numeric token IDs.
 * The ticker streams live quotes: last price, bid/ask, volume, OHLC, etc.
 *
 * RECONNECTION:
 * ──────────────
 * WebSocket connections can drop (internet blip, server restart, etc.).
 * The KiteTicker library handles reconnection automatically.
 * We also add our own logging so you can see when it reconnects.
 *
 * INSTRUMENT TOKENS:
 * ───────────────────
 * Each tradable instrument has a unique numeric "instrument token".
 * You look these up via kite.getInstruments() or from Zerodha's instrument dump.
 * Example: RELIANCE on NSE has token 738561
 *
 * HOW TO USE:
 *   const { startTicker } = require('./websocket');
 *   startTicker([738561, 408065]);   // RELIANCE, INFY
 *
 * PHASE 1 STATUS:
 * ────────────────
 * This module is fully functional in Phase 1.
 * In Phase 2 we will connect the live prices here to the conditions engine.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const { KiteTicker } = require('kiteconnect');
const logger         = require('./logger');
const { readSession } = require('./login');
const { formatCurrency } = require('./utils');

// Store the latest tick data here (in memory)
// Other modules can import this to read live prices
const latestTicks = new Map(); // Map<instrumentToken, tickData>

// ─────────────────────────────────────────────────────────────────────────────
// startTicker(instrumentTokens)
// ─────────────────────────────────────────────────────────────────────────────
// Connects to the Kite WebSocket and starts streaming quotes.
//
// @param {number[]} instrumentTokens  - Array of numeric instrument tokens to subscribe to
// @returns {KiteTicker}               - The ticker instance (call .disconnect() to stop)
//
function startTicker(instrumentTokens = []) {
  const session = readSession();

  if (!session || !session.access_token) {
    throw new Error(
      'No saved session found. Run `node src/login.js <request_token>` first.'
    );
  }

  if (instrumentTokens.length === 0) {
    logger.warn('startTicker called with no instrument tokens – nothing to subscribe to');
  }

  const ticker = new KiteTicker({
    api_key:      process.env.KITE_API_KEY,
    access_token: session.access_token,
  });

  // ── Event: connected ────────────────────────────────────────────────────────
  ticker.on('connect', () => {
    logger.info('🔌 WebSocket connected to Kite Ticker');

    if (instrumentTokens.length > 0) {
      // "full" mode gives you complete tick data including bid/ask depth
      // "quote" mode gives LTP, volume, OHLC
      // "ltp"   mode gives only the last traded price (lowest bandwidth)
      ticker.subscribe(instrumentTokens);
      ticker.setMode(ticker.modeFull, instrumentTokens);

      logger.info(`📡 Subscribed to ${instrumentTokens.length} instruments: [${instrumentTokens.join(', ')}]`);
    }
  });

  // ── Event: ticks received ───────────────────────────────────────────────────
  // This fires every time the server sends fresh price data.
  // Can fire many times per second for active instruments.
  //
  ticker.on('ticks', (ticks) => {
    ticks.forEach((tick) => {
      // Save the latest tick for each instrument
      latestTicks.set(tick.instrument_token, tick);

      // Log at "debug" level to avoid flooding your terminal during normal use
      // Change LOG_LEVEL=debug in .env to see every tick
      logger.debug(`📈 Tick [${tick.instrument_token}]`, {
        ltp:    tick.last_price,
        volume: tick.volume_traded,
        change: tick.change,
      });
    });
  });

  // ── Event: disconnected ─────────────────────────────────────────────────────
  ticker.on('disconnect', (err) => {
    if (err) {
      logger.warn('WebSocket disconnected with error', { error: err.message });
    } else {
      logger.info('WebSocket disconnected');
    }
  });

  // ── Event: error ────────────────────────────────────────────────────────────
  ticker.on('error', (err) => {
    const msg = err?.message || String(err) || 'unknown error';

    // 403 / 401 errors almost always mean one of three things:
    //   1. Your Kite Connect plan does not include WebSocket (Ticker) access
    //   2. Your access token has expired (re-run: node src/login.js)
    //   3. Your API key is wrong
    if (msg.includes('403') || msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
      logger.error('');
      logger.error('╔══════════════════════════════════════════════════════════╗');
      logger.error('║  ❌  WEBSOCKET ACCESS DENIED                             ║');
      logger.error('╠══════════════════════════════════════════════════════════╣');
      logger.error('║  Possible reasons:                                       ║');
      logger.error('║  1. Your Kite Connect subscription does not include      ║');
      logger.error('║     WebSocket (KiteTicker) streaming.                    ║');
      logger.error('║     → Check / upgrade at https://developers.kite.trade/ ║');
      logger.error('║  2. Your access token has expired.                       ║');
      logger.error('║     → Re-authenticate: node src/login.js <request_token>║');
      logger.error('║  3. Wrong API key in .env                                ║');
      logger.error('║     → Verify KITE_API_KEY in your .env file             ║');
      logger.error('╠══════════════════════════════════════════════════════════╣');
      logger.error('║  The spike monitor will NOT work without WebSocket.      ║');
      logger.error('║  Order placement and polling monitor are unaffected.     ║');
      logger.error('╚══════════════════════════════════════════════════════════╝');
      logger.error('');
    } else {
      logger.error('WebSocket error', { error: msg });
    }
  });

  // ── Event: reconnecting ─────────────────────────────────────────────────────
  ticker.on('reconnect', (reconnectCount, reconnectInterval) => {
    logger.warn(`WebSocket reconnecting… attempt ${reconnectCount} (interval: ${reconnectInterval}s)`);
  });

  // ── Event: noReconnect ──────────────────────────────────────────────────────
  // Fires when KiteTicker gives up trying to reconnect
  ticker.on('noreconnect', () => {
    logger.error('❌ WebSocket gave up reconnecting. Restart the bot to resume live data.');
  });

  // ── Event: order_update ─────────────────────────────────────────────────────
  // Kite also pushes order status changes through the WebSocket.
  // This lets you react the moment an order is filled without polling.
  //
  ticker.on('order_update', (order) => {
    logger.info(`📋 Order update: ${order.tradingsymbol}`, {
      order_id:         order.order_id,
      status:           order.status,
      filled_quantity:  order.filled_quantity,
      average_price:    order.average_price,
    });
  });

  // Connect!
  ticker.connect();

  logger.info('WebSocket connection initiated…');
  return ticker;
}

// ─────────────────────────────────────────────────────────────────────────────
// getLatestPrice(instrumentToken)
// ─────────────────────────────────────────────────────────────────────────────
// Returns the last known price for an instrument, or null if not yet received.
// Other modules (conditions.js) use this to get live prices.
//
function getLatestPrice(instrumentToken) {
  const tick = latestTicks.get(instrumentToken);
  return tick ? tick.last_price : null;
}

module.exports = { startTicker, getLatestPrice, latestTicks };
