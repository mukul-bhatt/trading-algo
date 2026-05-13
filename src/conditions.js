/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/conditions.js  –  Strategy Conditions & Automated Decisions
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE DOES:
 * ─────────────────────
 * This is where your "strategy logic" lives.
 * You define conditions like:
 *   "If my position is up 2%, book profit"
 *   "If price drops 1.5% from entry, place a stop-loss"
 *   "If stop-loss is triggered, trail it up with the market"
 *
 * WHY SEPARATE FROM monitor.js?
 *   monitor.js just OBSERVES (reads data and logs it).
 *   conditions.js DECIDES (should we act on what we see?).
 *   Separating observation from decision makes the code easier to test and tweak.
 *
 * HOW TO ADD YOUR OWN CONDITIONS:
 * ─────────────────────────────────
 * Each condition function receives a position or holding object and returns
 * true/false.  The evaluateConditions() function applies all of them.
 *
 * PHASE 1 SCOPE:
 * ──────────────
 * This file is intentionally basic in Phase 1 – just the framework.
 * Real stop-loss placement and trailing logic comes in Phase 2/3.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const logger          = require('./logger');
const { isDryRun, formatCurrency } = require('./utils');

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
// Each function returns true if the condition is met, false otherwise.
// They are pure functions (no side effects) – they just check numbers.

/**
 * isProfitTarget(position, targetPct)
 * Returns true if the position's PnL has exceeded the target percentage.
 *
 * Example: isProfitTarget(pos, 2.0) → true if you are up 2% or more
 *
 * @param {object} position  - A position object from kite.getPositions()
 * @param {number} targetPct - Target profit % (e.g. 2.0 for 2%)
 */
function isProfitTarget(position, targetPct = 2.0) {
  if (!position.average_price || position.average_price === 0) return false;

  const pnlPct = (position.pnl / (position.average_price * Math.abs(position.quantity))) * 100;
  return pnlPct >= targetPct;
}

/**
 * isStopLossBreached(position, stopLossPct)
 * Returns true if the position has dropped below the stop-loss threshold.
 *
 * Example: isStopLossBreached(pos, 1.5) → true if you are down 1.5% or more
 *
 * @param {object} position    - A position object
 * @param {number} stopLossPct - Maximum allowed loss % (e.g. 1.5 for 1.5%)
 */
function isStopLossBreached(position, stopLossPct = 1.5) {
  if (!position.average_price || position.average_price === 0) return false;

  const pnlPct = (position.pnl / (position.average_price * Math.abs(position.quantity))) * 100;
  return pnlPct <= -stopLossPct;
}

/**
 * isPriceAbove(ltp, level)
 * Returns true if the current market price is above a given level.
 * Useful for triggering trailing stop updates.
 */
function isPriceAbove(ltp, level) {
  return ltp > level;
}

/**
 * isPriceBelow(ltp, level)
 * Returns true if the current market price is below a given level.
 */
function isPriceBelow(ltp, level) {
  return ltp < level;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluatePositions(positions, kite)
// ─────────────────────────────────────────────────────────────────────────────
// Loops through all open positions and checks conditions.
// Logs what actions WOULD be taken.
// Phase 1: LOGGING ONLY.
// Phase 2: Will actually call exit/SL APIs.
//
async function evaluatePositions(positions, kite) {
  if (!positions || positions.length === 0) return;

  for (const pos of positions) {
    const symbol = pos.tradingsymbol;
    const ltp    = pos.last_price;
    const pnl    = pos.pnl;
    const avgPx  = pos.average_price;

    // ── Check profit target (2%) ────────────────────────────────────────────
    if (isProfitTarget(pos, 2.0)) {
      const action = `BOOK PROFIT on ${symbol}: LTP=${formatCurrency(ltp)}, PnL=${formatCurrency(pnl)}`;

      if (isDryRun()) {
        logger.info(`🧪 [DRY RUN] Would: ${action}`);
      } else {
        // TODO Phase 2: call exitPosition(kite, pos)
        logger.warn(`🎯 PROFIT TARGET HIT → ${action}`);
        logger.info('   (Auto-exit not yet implemented – coming in Phase 2)');
      }
    }

    // ── Check stop-loss (1.5%) ──────────────────────────────────────────────
    if (isStopLossBreached(pos, 1.5)) {
      const action = `EXIT POSITION ${symbol}: LTP=${formatCurrency(ltp)}, PnL=${formatCurrency(pnl)}`;

      if (isDryRun()) {
        logger.info(`🧪 [DRY RUN] Would trigger stop-loss: ${action}`);
      } else {
        // TODO Phase 2: call exitPosition(kite, pos)
        logger.warn(`🛑 STOP LOSS BREACHED → ${action}`);
        logger.info('   (Auto-exit not yet implemented – coming in Phase 2)');
      }
    }
  }
}

module.exports = {
  isProfitTarget,
  isStopLossBreached,
  isPriceAbove,
  isPriceBelow,
  evaluatePositions,
};
