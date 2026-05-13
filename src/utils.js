/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/utils.js  –  Shared utility / helper functions
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT GOES HERE?
 * ───────────────
 * Small, general-purpose functions that are used by multiple other modules.
 * Keeping them here instead of duplicating them everywhere:
 *   • makes the codebase easier to read (each file does one thing)
 *   • means you only fix a bug in one place
 *
 * CONTENTS:
 *   sleep()          – pause execution for N milliseconds
 *   retry()          – call an async function up to N times before giving up
 *   isDryRun()       – check if we are in paper-trading mode
 *   formatCurrency() – pretty-print an INR amount
 *   isMarketHours()  – true if current time is within NSE trading hours
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// sleep(ms)
// ─────────────────────────────────────────────────────────────────────────────
// Pauses async code for `ms` milliseconds.
//
// HOW IT WORKS:
//   JavaScript is single-threaded.  You can't "block" it without freezing the
//   whole program.  Instead we return a Promise that resolves after a timeout.
//   Callers use "await sleep(1000)" and the event loop runs other things while
//   waiting.
//
// USAGE:
//   await sleep(1000);  // wait 1 second
//   await sleep(500);   // wait 500 ms
//
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// retry(fn, options)
// ─────────────────────────────────────────────────────────────────────────────
// Calls async function `fn` up to `maxAttempts` times.
// Waits `delayMs` between attempts (doubles each time – "exponential back-off").
//
// WHY RETRY?
//   Network calls fail occasionally:
//     • Kite's API might return a 500 error for a fraction of a second
//     • Your internet connection might hiccup
//   Retrying automatically means a temporary blip doesn't kill your bot.
//
// USAGE:
//   const result = await retry(() => kite.placeOrder(...), { maxAttempts: 3 });
//
// OPTIONS (all optional, defaults shown):
//   maxAttempts  – how many total tries (default 3)
//   delayMs      – initial delay between tries in ms (default 1000 = 1 second)
//   label        – a name for logging (e.g. "placeOrder for RELIANCE")
//
async function retry(fn, { maxAttempts = 3, delayMs = 1000, label = 'operation' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Try calling the function
      const result = await fn();
      if (attempt > 1) {
        logger.info(`✅ ${label} succeeded on attempt ${attempt}`);
      }
      return result;

    } catch (err) {
      lastError = err;
      const isLast = attempt === maxAttempts;

      if (isLast) {
        logger.error(`❌ ${label} failed after ${maxAttempts} attempts`, {
          error: err.message,
        });
      } else {
        // Exponential back-off: wait 1s, then 2s, then 4s …
        const waitMs = delayMs * Math.pow(2, attempt - 1);
        logger.warn(`⚠️  ${label} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs}ms…`, {
          error: err.message,
        });
        await sleep(waitMs);
      }
    }
  }

  // All attempts exhausted – re-throw the last error so the caller can handle it
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// isDryRun()
// ─────────────────────────────────────────────────────────────────────────────
// Returns true when DRY_RUN=true is set in .env.
//
// In dry-run mode the bot logs every action it WOULD take but does not actually
// call any order-placement APIs.  This is how you safely test your strategy
// without putting real money at risk.
//
function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
// formatCurrency(amount)
// ─────────────────────────────────────────────────────────────────────────────
// Returns a pretty INR string:  formatCurrency(1234567.89) → "₹12,34,567.89"
//
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '₹–';
  return new Intl.NumberFormat('en-IN', {
    style:    'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// isMarketHours()
// ─────────────────────────────────────────────────────────────────────────────
// Returns true if the current IST time is within NSE regular market hours.
//
// NSE trades:  Monday–Friday, 09:15 AM – 03:30 PM IST
//
// WHY THIS MATTERS:
//   Placing orders outside market hours will fail or be queued until the next
//   session.  Checking upfront saves confusing error messages.
//
function isMarketHours() {
  // Get current time in IST (UTC+5:30)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in ms
  const ist = new Date(now.getTime() + istOffset);

  const day         = ist.getUTCDay();   // 0=Sun, 1=Mon … 6=Sat
  const hours       = ist.getUTCHours();
  const minutes     = ist.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  const isWeekday  = day >= 1 && day <= 5;            // Monday–Friday
  const afterOpen  = totalMinutes >= (9 * 60 + 0);    // 09:00 (including pre-market)
  const beforeClose= totalMinutes <= (15 * 60 + 30);  // 15:30

  return isWeekday && afterOpen && beforeClose;
}

// ─────────────────────────────────────────────────────────────────────────────
// getISTTime()
// ─────────────────────────────────────────────────────────────────────────────
// Returns current time as a human-readable IST string for logs.
//
function getISTTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

module.exports = {
  sleep,
  retry,
  isDryRun,
  formatCurrency,
  isMarketHours,
  getISTTime,
};
