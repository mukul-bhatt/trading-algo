/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/logger.js  –  Centralised logging using Winston
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A DEDICATED LOGGER?
 * ─────────────────────────
 * Using console.log() everywhere is fine for quick scripts, but for a trading
 * bot you need:
 *   1. Timestamps  – so you know exactly when something happened
 *   2. Log levels  – "info" for normal events, "error" for failures, "debug"
 *                    for extra detail while developing
 *   3. File output – you want a permanent record of every order placed, every
 *                    error, every price seen.  console.log only writes to the
 *                    terminal; once you close it, it is gone.
 *
 * Winston supports all three out of the box.
 *
 * LOG LEVELS (from most severe → least severe):
 *   error   – something broke, needs immediate attention
 *   warn    – something unusual happened but the bot continued
 *   info    – normal operational events (orders placed, market open, etc.)
 *   debug   – very detailed tracing, usually only needed while developing
 *
 * HOW IT IS USED ELSEWHERE:
 *   const logger = require('./logger');
 *   logger.info('Order placed successfully');
 *   logger.error('API call failed', { error: err.message });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// Load environment variables so we can read LOG_LEVEL from .env
require('dotenv').config();

const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

// ── Ensure the logs/ directory exists ────────────────────────────────────────
// __dirname is the absolute path of the current file's folder (src/)
// We go one level up (..) and then into logs/
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ── Build today's date string for the log filename ───────────────────────────
// Example: "2026-05-09"  →  logs/bot-2026-05-09.log
function todayString() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ── Custom format: timestamp + level + message + optional metadata ────────────
//
// Winston "formats" are middleware that transform the log entry before it is
// written.  We chain them with winston.format.combine().
//
const logFormat = winston.format.combine(
  // Add a "timestamp" field to every log entry
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),

  // When we pass an Error object as metadata, print its stack trace
  winston.format.errors({ stack: true }),

  // Custom formatter that turns the log entry into a readable string
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    // If there is extra metadata (like an order object), pretty-print it
    const extras = Object.keys(meta).length
      ? '\n  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')
      : '';

    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} │ ${message}${extras}`;
  })
);

// ── Console format: same as above but with colours ───────────────────────────
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),  // colours based on level
  logFormat
);

// ── Create the logger instance ────────────────────────────────────────────────
const logger = winston.createLogger({
  // Read from .env; default to "info" if not set
  level: process.env.LOG_LEVEL || 'info',

  // "transports" = destinations where logs are written
  transports: [

    // 1. Console – so you can watch what is happening in real time
    new winston.transports.Console({
      format: consoleFormat,
    }),

    // 2. Daily log file – everything (info and above) goes here
    new winston.transports.File({
      filename: path.join(logsDir, `bot-${todayString()}.log`),
      format:   logFormat,
      // Rotate: if the file exceeds 10 MB, start a new one
      maxsize:  10 * 1024 * 1024, // 10 MB
      maxFiles: 14,               // keep 14 days of logs
    }),

    // 3. Separate error-only file – makes it easy to scan just for problems
    new winston.transports.File({
      filename: path.join(logsDir, `errors-${todayString()}.log`),
      level:    'error',          // only write "error" level entries here
      format:   logFormat,
    }),
  ],
});

module.exports = logger;
