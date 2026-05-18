/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/main.js  –  Application Entry Point & Scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE DOES:
 * ─────────────────────
 * This is the "brain" of the trading bot.  It:
 *
 *   1. Reads the command you type (e.g. `node src/main.js` or `npm start`)
 *   2. Schedules basket orders to be placed at 9:15 AM using node-cron
 *   3. Starts the position monitor after orders are placed
 *   4. Handles clean shutdown (Ctrl+C) gracefully
 *
 * SCHEDULER – node-cron:
 * ───────────────────────
 * node-cron runs code at specified times using "cron syntax":
 *
 *   "15 9 * * 1-5"  means:
 *     15        → minute 15
 *     9         → hour 9 (9 AM)
 *     *         → any day of month
 *     *         → any month
 *     1-5       → Monday through Friday (1=Mon, 5=Fri)
 *
 * So "15 9 * * 1-5" = "At 09:15 on every weekday"
 *
 * COMMANDS:
 * ─────────
 *   node src/main.js             → Run scheduler + monitor (full bot mode)
 *   node src/main.js orders      → Place basket orders right now (manual trigger)
 *   node src/main.js monitor     → Only start the position monitor
 *   node src/login.js            → (separate) Manage authentication
 *
 * SAFETY:
 * ───────
 * The scheduler only fires on weekdays (1-5 in cron) during market hours.
 * Even then, DRY_RUN=true in .env prevents real order placement until you
 * are ready to go live.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ALWAYS load dotenv first, before anything else reads process.env
require('dotenv').config();

const cron   = require('node-cron');
const logger = require('./logger');
const { placeBasketOrders }     = require('./placeOrders');
const { placePcaBasketOrders }  = require('./pcaOrders');
const { startMonitor }          = require('./monitor');
const { startHoldingsMonitor }  = require('./holdingsMonitor');
const { startCircuitGuard }     = require('./circuitGuard');
const { scheduleIlliquidSell }  = require('./illiquidSell');
const { isDryRun, getISTTime, isMarketHours } = require('./utils');

// ─────────────────────────────────────────────────────────────────────────────
// Banner – printed at startup
// ─────────────────────────────────────────────────────────────────────────────
function printBanner() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║         ZERODHA TRADING BOT  v1.1                   ║');
  logger.info('║         Kite Connect Automation Engine               ║');
  logger.info('║         + Operator-Exit Spike Monitor                ║');
  logger.info('║         + Periodic Call Auction (PCA) Scheduler      ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info(`  Mode:    ${isDryRun() ? '🧪 DRY RUN (paper trading)' : '🔴 LIVE TRADING'}`);
  logger.info(`  Time:    ${getISTTime()}`);
  logger.info(`  Market:  ${isMarketHours() ? '🟢 Open' : '🔴 Closed'}`);
  logger.info('');

  logger.info('  ┌───────────────── DAILY REMINDERS ──────────────────┐');
  logger.info('  │ 1. Is your current IP address whitelisted on Kite? │');
  logger.info('  │    (If not, your orders will be rejected)          │');
  logger.info('  │ 2. Did you complete CDSL Authorization today?      │');
  logger.info('  │    (Required to sell delivery holdings)            │');
  logger.info('  └────────────────────────────────────────────────────┘');
  logger.info('');

  if (isDryRun()) {
    logger.info('  ┌────────────────────────────────────────────────────┐');
    logger.info('  │  DRY RUN MODE is ON                                │');
    logger.info('  │  No real orders will be placed.                    │');
    logger.info('  │  Set DRY_RUN=false in .env when ready to go live.  │');
    logger.info('  └────────────────────────────────────────────────────┘');
    logger.info('');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runOrdersNow()
// ─────────────────────────────────────────────────────────────────────────────
// Places basket orders immediately.  Used for:
//   • Manual trigger: node src/main.js orders
//   • Called by the cron scheduler at 9:15 AM
//
async function runOrdersNow() {
  logger.info('⏰ Triggering basket order placement…');
  try {
    const results = await placeBasketOrders();
    return results;
  } catch (err) {
    logger.error('Basket order placement failed', { error: err.message });
    // Don't throw – let the bot keep running for monitoring even if orders fail
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// scheduleOrders()
// ─────────────────────────────────────────────────────────────────────────────
// Sets up a cron job to fire at 9:00 AM every weekday.
//
// WHY 9:00 AM AND NOT 9:15 AM?
//   NSE has a pre-open session from 9:00–9:15 AM.
//   Orders placed during this window queue up and execute at the
//   opening price discovered by auction at 9:15 AM.
//   This is ideal for CNC orders — you're first in queue at market open.
//
// THE 500ms DELAY:
//   After the cron fires at exactly 9:00:00.000, we wait 500ms before
//   placing orders. This gives the Kite API servers a tiny moment to
//   settle and accept pre-open orders cleanly.
//
function scheduleOrders() {
  // "0 9 * * 1-5" → 09:00:00 AM sharp, Monday–Friday
  const cronExpression = '0 9 * * 1-5';
  const PRE_PLACE_DELAY_MS = 50; // 50 milliseconds

  logger.info('🕐 Order schedule: daily at 09:00:00 AM IST (weekdays)');
  logger.info('   Pre-open session: orders queue for 9:15 AM market open');
  logger.info('   Cron expression:  ' + cronExpression);

  cron.schedule(
    cronExpression,
    async () => {
      logger.info('⏰ Cron fired at 9:00 AM – waiting 50ms before placing orders…');

      // Small delay so the API is ready to accept pre-open orders
      await new Promise((resolve) => setTimeout(resolve, PRE_PLACE_DELAY_MS));

      logger.info('🚀 Placing basket orders now (pre-open session)');
      await runOrdersNow();
    },
    {
      // IMPORTANT: set the timezone so "9 AM" means 9 AM IST, not UTC
      timezone: 'Asia/Kolkata',
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// schedulePcaOrders()
// ─────────────────────────────────────────────────────────────────────────────
// Sets up a cron job to fire at exactly 9:30:00 AM every weekday —
// the moment NSE opens Session 1 of the Periodic Call Auction.
//
// PCA SESSION REFERENCE:
//   Session 1  →  9:30 AM – 10:15 AM  (45-min auction)
//   Buffer     →  10:15 AM – 10:30 AM (15-min gap)
//   Session 2  →  10:30 AM – 11:15 AM
//   … and so on.  This scheduler targets Session 1 only.
//
// WHY NOT PRE-OPEN (9:00 AM)?
//   PCA stocks are NOT part of the NSE pre-open session.
//   The exchange only accepts PCA orders once the auction window opens.
//   Sending them at 9:00 AM would result in rejection.
//
function schedulePcaOrders() {
  // "30 9 * * 1-5" → 9:30:00 AM sharp, Monday–Friday IST
  const cronExpression   = '30 9 * * 1-5';
  const POST_FIRE_DELAY  = 200; // ms – small buffer after cron fires

  logger.info('🕐 PCA order schedule: Session 1 at 09:30:00 AM IST (weekdays)');
  logger.info('   PCA session window: 9:30 AM – 10:15 AM (45 min auction)');
  logger.info('   Cron expression:   ' + cronExpression);

  cron.schedule(
    cronExpression,
    async () => {
      logger.info('⏰ PCA cron fired at 9:30 AM – waiting 200ms before placing orders…');
      await new Promise((resolve) => setTimeout(resolve, POST_FIRE_DELAY));
      logger.info('🚀 Placing PCA basket orders now (Session 1 open)');
      try {
        await placePcaBasketOrders();
      } catch (err) {
        logger.error('PCA basket placement failed', { error: err.message });
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// gracefulShutdown()
// ─────────────────────────────────────────────────────────────────────────────
// Called when the user presses Ctrl+C.
// Logs a clean shutdown message instead of a cryptic crash.
//
function gracefulShutdown(signal) {
  logger.info(`\n${signal} received. Shutting down gracefully…`);
  logger.info('Bot stopped. Goodbye!');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// main()
// ─────────────────────────────────────────────────────────────────────────────
// Entry point.
//
async function main() {
  printBanner();

  // Read the command from the terminal
  // process.argv looks like: ['node', 'src/main.js', 'orders']
  const command = process.argv[2] || 'start';

  // ── Handle Ctrl+C cleanly ─────────────────────────────────────────────────
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // ── Unhandled promise rejections – log instead of crashing ────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
    // Don't exit – let the bot keep running
  });

  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND: orders
  // Place basket orders RIGHT NOW and exit
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'orders') {
    logger.info('Command: place orders now');
    await runOrdersNow();
    logger.info('Done. Exiting.');
    process.exit(0);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND: monitor
  // Only start the polling monitor (no order scheduling, no spike monitor)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'monitor') {
    logger.info('Command: polling monitor only (no order scheduling)');
    await startMonitor();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND: holdingswatch
  // Only start the real-time holdings spike monitor (no orders, no polling)
  // Use this to test the spike detector in isolation.
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'holdingswatch') {
    logger.info('Command: holdings spike monitor only');
    await startHoldingsMonitor();
    // startHoldingsMonitor returns after setup; the process stays alive via
    // the WebSocket connection and the refresh interval.
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND: pcaorders
  // Place PCA basket orders RIGHT NOW (manual trigger, skips the 9:30 cron)
  // Useful for testing or if you need to place manually outside the schedule.
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'pcaorders') {
    logger.info('Command: place PCA basket orders now (manual trigger)');
    try {
      await placePcaBasketOrders();
    } catch (err) {
      logger.error('PCA basket placement failed', { error: err.message });
    }
    logger.info('Done. Exiting.');
    process.exit(0);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND: illiquidsell
  // Manually trigger the illiquid sell prep and execution immediately
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'illiquidsell') {
    logger.info('Command: illiquid sell trigger immediately');
    const { prepareIlliquidOrders, executeIlliquidOrders } = require('./illiquidSell');
    await prepareIlliquidOrders();
    await executeIlliquidOrders();
    logger.info('Done. Exiting.');
    process.exit(0);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT: start (full bot)
  // Schedule orders at 9:00 AM + polling monitor + spike monitor
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'start') {
    logger.info('Starting full bot: scheduler + polling monitor + holdings spike monitor + circuit guard');

    // Set up the 9:00 AM regular basket scheduler (pre-open)
    scheduleOrders();

    // Set up the 9:30 AM PCA basket scheduler (Session 1)
    schedulePcaOrders();

    // Set up the 9:30 AM illiquid stocks sell scheduler (T2T call auction)
    scheduleIlliquidSell();

    // Start the lower circuit guard
    // Polls every 30s for open BUY orders that are at lower circuit → cancels them
    startCircuitGuard().catch((err) =>
      logger.error('Circuit guard failed to start', { error: err.message })
    );

    // Start the holdings spike monitor (WebSocket-based, runs in background)
    // We do NOT await – it sets up the WS connection and returns.
    // The process stays alive via the WS connection + setTimeout loops.
    startHoldingsMonitor().catch((err) =>
      logger.error('Holdings monitor failed to start', { error: err.message })
    );

    // Start the polling monitor (runs its first cycle then schedules via setTimeout)
    await startMonitor();
    return;
  }

  // Unknown command
  logger.error(`Unknown command: "${command}"`);
  logger.info('Available commands:');
  logger.info('  node src/main.js               → Full bot (scheduler + monitors + circuit guard)');
  logger.info('  node src/main.js orders        → Place regular basket orders now (9:00 AM pre-open)');
  logger.info('  node src/main.js pcaorders     → Place PCA basket orders now (Session 1 / 9:30 AM)');
  logger.info('  node src/main.js monitor       → Polling monitor only (positions, holdings, orders)');
  logger.info('  node src/main.js holdingswatch → Real-time holdings spike monitor only');
  logger.info('  node src/main.js illiquidsell  → Run illiquid sell routine immediately');
  logger.info('  node src/login.js              → Manage login / access token');
  process.exit(1);
}

// Run!
main().catch((err) => {
  logger.error('Fatal error in main()', { error: err.message });
  process.exit(1);
});
