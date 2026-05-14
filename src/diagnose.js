/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/diagnose.js  –  Connectivity Diagnostic Tool
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Verifies that your Kite Connect setup is working end-to-end:
 *   1. Access token is valid (profile API)
 *   2. getQuote() REST API works (market data)
 *   3. WebSocket (KiteTicker) connects and receives ticks
 *
 * USAGE:
 *   node src/diagnose.js
 *
 * Run this DURING MARKET HOURS (9:15 AM – 3:30 PM) for the WebSocket test
 * to receive real tick data. Outside market hours the WebSocket will connect
 * but will not stream ticks (the exchange is closed).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const { getKiteClient } = require('./login');
const { KiteTicker }    = require('kiteconnect');

// We test against INFY on NSE — it is always available and liquid.
const TEST_SYMBOL        = 'NSE:INFY';
const TEST_TOKEN         = 408065; // INFY instrument token (stable, never changes)
const WEBSOCKET_TIMEOUT  = 15000;  // 15s to wait for first tick

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(msg)  { console.log(`  ✅  ${msg}`); }
function fail(msg)  { console.log(`  ❌  ${msg}`); }
function info(msg)  { console.log(`  ℹ️   ${msg}`); }
function header(msg){ console.log(`\n${'─'.repeat(60)}\n  ${msg}\n${'─'.repeat(60)}`); }

// ── Test 1: Access token ──────────────────────────────────────────────────────

async function testAccessToken(kite) {
  header('TEST 1 — Access Token (Profile API)');
  try {
    const profile = await kite.getProfile();
    pass(`Logged in as: ${profile.user_name} (${profile.user_id})`);
    pass(`Email       : ${profile.email}`);
    return true;
  } catch (err) {
    fail(`Profile fetch failed: ${err.message}`);
    info('→ Your access token is invalid or expired.');
    info('  Run: node src/login.js <request_token>  to generate a fresh token.');
    return false;
  }
}

// ── Test 2: getQuote REST API ─────────────────────────────────────────────────

async function testGetQuote(kite) {
  header('TEST 2 — Market Quote API  (getQuote)');
  info(`Fetching quote for ${TEST_SYMBOL}…`);
  try {
    const quotes = await kite.getQuote([TEST_SYMBOL]);
    const q      = quotes[TEST_SYMBOL];

    if (!q) {
      fail(`Response OK but no data for ${TEST_SYMBOL}`);
      return false;
    }

    pass(`getQuote() is WORKING`);
    pass(`  Last price         : ₹${q.last_price}`);
    pass(`  Lower circuit limit: ₹${q.lower_circuit_limit}`);
    pass(`  Upper circuit limit: ₹${q.upper_circuit_limit}`);
    pass(`  Volume             : ${q.volume?.toLocaleString('en-IN')} shares`);
    info('→ Circuit guard will work correctly with your API key.');
    return true;

  } catch (err) {
    fail(`getQuote() failed: ${err.message}`);

    if (err.message?.toLowerCase().includes('insufficient permission')) {
      info('→ Possible causes:');
      info('  A) Your Kite Connect app does not have the "data" scope enabled.');
      info('     Fix: Go to https://developers.kite.trade/ → your app → enable "data" scope.');
      info('  B) You ran this outside market hours (quotes may be unavailable).');
      info('  C) Your access token is from before you enabled the scope — regenerate it.');
    }
    return false;
  }
}

// ── Test 3: getLTP REST API ───────────────────────────────────────────────────

async function testGetLTP(kite) {
  header('TEST 3 — LTP API  (getLTP)');
  info(`Fetching LTP for ${TEST_SYMBOL}…`);
  try {
    const ltpData = await kite.getLTP([TEST_SYMBOL]);
    const ltp     = ltpData[TEST_SYMBOL]?.last_price;
    pass(`getLTP() is WORKING`);
    pass(`  INFY LTP: ₹${ltp}`);
    return true;
  } catch (err) {
    fail(`getLTP() failed: ${err.message}`);
    return false;
  }
}

// ── Test 4: WebSocket (KiteTicker) ────────────────────────────────────────────

function testWebSocket() {
  return new Promise((resolve) => {
    header('TEST 4 — WebSocket / KiteTicker');
    info('Attempting to connect to wss://ws.kite.trade…');

    const apiKey      = process.env.KITE_API_KEY;
    const accessToken = process.env.ACCESS_TOKEN;

    if (!apiKey || !accessToken) {
      fail('KITE_API_KEY or ACCESS_TOKEN missing from .env');
      resolve(false);
      return;
    }

    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    let resolved = false;
    const done   = (success) => {
      if (!resolved) {
        resolved = true;
        try { ticker.disconnect(); } catch (_) {}
        resolve(success);
      }
    };

    // Timeout — if no tick arrives within WEBSOCKET_TIMEOUT ms
    const timeout = setTimeout(() => {
      info('No tick received within the timeout window.');
      info('This is NORMAL outside of market hours (9:15 AM – 3:30 PM).');
      info('If you are running this during market hours and still see this,');
      info('your WebSocket "connects" may not be active on your Zerodha account.');
      done(false);
    }, WEBSOCKET_TIMEOUT);

    ticker.on('connect', () => {
      pass('WebSocket CONNECTED to wss://ws.kite.trade');
      pass('Subscribing to INFY (token 408065) in full mode…');
      ticker.subscribe([TEST_TOKEN]);
      ticker.setMode(ticker.modeFull, [TEST_TOKEN]);
    });

    ticker.on('ticks', (ticks) => {
      clearTimeout(timeout);
      const t = ticks[0];
      pass('WebSocket is WORKING — tick data is arriving!');
      pass(`  Instrument token: ${t.instrument_token}`);
      pass(`  Last price      : ₹${t.last_price}`);
      pass(`  Mode            : ${t.mode}`);
      if (t.ohlc) {
        pass(`  Prev close (ohlc.close): ₹${t.ohlc.close}  ← used by stop-loss`);
      }
      if (t.depth) {
        pass(`  Market depth    : available (full mode confirmed)`);
      }
      info('→ Your WebSocket connects are active and working.');
      done(true);
    });

    ticker.on('error', (err) => {
      clearTimeout(timeout);
      fail(`WebSocket error: ${JSON.stringify(err)}`);
      info('→ Possible causes:');
      info('  A) You have not purchased WebSocket "connects" on your Zerodha account.');
      info('     Buy at: https://kite.trade/connect/');
      info('  B) Your API key is correct but the access token is expired.');
      info('  C) Network issue — try again.');
      done(false);
    });

    ticker.on('close', () => {
      if (!resolved) {
        fail('WebSocket connection closed before any tick was received.');
        done(false);
      }
    });

    ticker.connect();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Zerodha Kite Connect — Diagnostic Tool');
  console.log('══════════════════════════════════════════════════════════════');

  let kite;
  try {
    kite = getKiteClient();
  } catch (err) {
    fail(`Could not load Kite client: ${err.message}`);
    info('Make sure you have run: node src/login.js <request_token>');
    process.exit(1);
  }

  const r1 = await testAccessToken(kite);
  if (!r1) {
    console.log('\n⛔ Stopping — fix the access token first, then re-run.\n');
    process.exit(1);
  }

  const r2 = await testGetQuote(kite);
  const r3 = await testGetLTP(kite);
  const r4 = await testWebSocket();

  // ── Summary ───────────────────────────────────────────────────────────────
  header('SUMMARY');
  console.log(`  Access token (login)  : ${r1 ? '✅ OK' : '❌ FAILED'}`);
  console.log(`  getQuote() REST API   : ${r2 ? '✅ OK' : '❌ FAILED'} ← needed by circuit guard`);
  console.log(`  getLTP()   REST API   : ${r3 ? '✅ OK' : '❌ FAILED'} ← needed by use_ltp SELL orders`);
  console.log(`  WebSocket / KiteTicker: ${r4 ? '✅ OK' : '⚠️  No tick (check market hours / connects)'}`);

  if (r1 && r2 && r3 && r4) {
    console.log('\n  🎉 Everything is working. Your bot is ready.\n');
  } else {
    console.log('\n  ⚠️  Fix the items above and re-run this script.\n');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
