/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/login.js  –  Kite Connect Authentication Flow
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HOW KITE CONNECT AUTHENTICATION WORKS (read this carefully!):
 * ─────────────────────────────────────────────────────────────
 *
 * Kite Connect uses a TWO-STEP login process (similar to OAuth2):
 *
 *   STEP 1 – Get a "request token"
 *     - You open a special Kite login URL in your browser
 *     - You log in with your Zerodha username + password + TOTP
 *     - Zerodha redirects your browser to your app's "redirect URL"
 *     - The redirect URL contains a one-time "request_token" in the query string
 *       Example: https://yourapp.com/callback?request_token=XXXXXXXX&status=success
 *     - You copy that request_token value
 *
 *   STEP 2 – Exchange for an "access token"
 *     - You call kite.generateSession(requestToken, apiSecret)
 *     - Zerodha returns an "access_token" valid for ONE day
 *     - Every API call from that point uses this access_token
 *
 *   STEP 3 – Save the access token
 *     - We save it to kite-session.json so we don't re-login on every run
 *     - Access tokens expire at midnight IST; you must repeat Steps 1-2 each day
 *
 * HOW TO USE THIS FILE:
 * ──────────────────────
 *   1. First run:  node src/login.js
 *      → Prints the login URL.  Open it in your browser and log in.
 *
 *   2. Copy the request_token from the redirected URL in your browser address bar.
 *
 *   3. Second run:  node src/login.js <paste-request-token-here>
 *      → Exchanges it for an access token and saves it to kite-session.json
 *
 *   After this, all other scripts (placeOrders, monitor, etc.) automatically
 *   read from kite-session.json so you don't need to log in again until midnight.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// dotenv reads your .env file and makes those variables available as
// process.env.VARIABLE_NAME throughout the application.
// IMPORTANT: require('dotenv').config() must be called before reading any env vars.
require('dotenv').config();

const { KiteConnect } = require('kiteconnect');
const fs   = require('fs');
const path = require('path');

const logger      = require('./logger');
const { getISTTime } = require('./utils');

// ── Constants ─────────────────────────────────────────────────────────────────

// Path where we save the session (access_token, etc.)
// We place it at the project root so it is easy to find.
const SESSION_PATH = path.join(__dirname, '..', 'kite-session.json');

// Read from environment (set in .env file)
const API_KEY    = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;

// ── readSession() ─────────────────────────────────────────────────────────────
// Reads the saved session from disk.
// Returns the session object, or null if no session file exists.
//
function readSession() {
  if (!fs.existsSync(SESSION_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(SESSION_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to read session file', { error: err.message });
    return null;
  }
}

// ── saveSession(session) ──────────────────────────────────────────────────────
// Saves relevant session fields to kite-session.json.
// We only save what we need; discarding sensitive fields we don't need later.
//
function saveSession(session) {
  const data = {
    access_token:  session.access_token,
    public_token:  session.public_token,
    user_id:       session.user_id,
    user_name:     session.user_name,
    email:         session.email,
    login_time:    session.login_time,
    saved_at:      new Date().toISOString(),
  };

  fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
  logger.info('✅ Session saved to kite-session.json');
}

// ── createKiteClient(accessToken) ─────────────────────────────────────────────
// Factory function: creates and configures a KiteConnect instance.
// Every part of the bot that needs to talk to the API calls this.
//
// WHY A FACTORY FUNCTION?
//   We want one standard way to create a KiteConnect client everywhere.
//   This way, if we ever need to add something to every client (e.g. a hook),
//   we only change it here.
//
function createKiteClient(accessToken) {
  const kite = new KiteConnect({ api_key: API_KEY });

  if (accessToken) {
    kite.setAccessToken(accessToken);
  }

  // This hook fires when the API detects the session has expired.
  // We log a clear human-readable message instead of a cryptic error.
  kite.setSessionExpiryHook(() => {
    logger.error(
      '🔑 Access token has EXPIRED. Please run `node src/login.js` to log in again.'
    );
    process.exit(1); // stop the bot – it cannot function without a valid token
  });

  return kite;
}

// ── getKiteClient() ───────────────────────────────────────────────────────────
// High-level helper used by other modules.
// Loads the saved session and returns a ready-to-use KiteConnect client.
// Throws a descriptive error if not logged in yet.
//
function getKiteClient() {
  const session = readSession();

  if (!session || !session.access_token) {
    throw new Error(
      'No saved session found.\n' +
      'Run:  node src/login.js\n' +
      'Then: node src/login.js <request_token>\n' +
      'to generate and save an access token.'
    );
  }

  logger.debug('Loaded session from file', {
    user_id:    session.user_id,
    login_time: session.login_time,
  });

  return createKiteClient(session.access_token);
}

// ── login(requestToken) ───────────────────────────────────────────────────────
// Main login logic.
//
// If requestToken is NOT provided → print the login URL for the user to open.
// If requestToken IS provided     → exchange it for an access token and save.
//
async function login(requestToken) {
  // Guard: make sure the API key and secret are set in .env
  if (!API_KEY || API_KEY === 'your_api_key_here') {
    throw new Error(
      'KITE_API_KEY is not set. Edit your .env file with your real API key.'
    );
  }
  if (!API_SECRET || API_SECRET === 'your_api_secret_here') {
    throw new Error(
      'KITE_API_SECRET is not set. Edit your .env file with your real API secret.'
    );
  }

  const kite = new KiteConnect({ api_key: API_KEY });

  // ── No request token yet → print the URL ─────────────────────────────────
  if (!requestToken) {
    const loginURL = kite.getLoginURL();
    logger.info('─────────────────────────────────────────────────────');
    logger.info('STEP 1: Open this URL in your browser and log in:');
    logger.info('');
    logger.info(`  ${loginURL}`);
    logger.info('');
    logger.info('STEP 2: After logging in, Zerodha will redirect you.');
    logger.info('        Copy the "request_token" from the URL bar.');
    logger.info('        It looks like:  ?request_token=XXXXXXXXXXXXXX');
    logger.info('');
    logger.info('STEP 3: Run:  node src/login.js <paste-request-token-here>');
    logger.info('─────────────────────────────────────────────────────');
    return;
  }

  // ── Exchange the request token for an access token ────────────────────────
  logger.info('Exchanging request token for access token…');

  try {
    // This is the key API call.  It requires:
    //   - the one-time request_token  (from your browser redirect)
    //   - your api_secret             (from your Kite app dashboard)
    // Zerodha verifies these and returns a session object with the access_token.
    const session = await kite.generateSession(requestToken, API_SECRET);

    saveSession(session);

    logger.info('─────────────────────────────────────────────────────');
    logger.info('🎉 Login successful!');
    logger.info(`   User:        ${session.user_name} (${session.user_id})`);
    logger.info(`   Login time:  ${session.login_time}`);
    logger.info(`   IST time:    ${getISTTime()}`);
    logger.info('─────────────────────────────────────────────────────');
    logger.info('You can now run:  node src/main.js');

  } catch (err) {
    // Common reasons for failure:
    //   - request_token already used (each token is one-time only)
    //   - request_token is wrong / copied incorrectly
    //   - API secret is wrong
    const detail = err?.response?.data?.message || err.message;
    logger.error('Login failed', { error: detail });
    logger.info('💡 Tips:');
    logger.info('   • The request_token can only be used ONCE.');
    logger.info('   • Go back to the login URL and generate a fresh one.');
    logger.info('   • Make sure you copied the full token (no trailing spaces).');
    process.exit(1);
  }
}

// ── Script entry point ────────────────────────────────────────────────────────
// When this file is run directly (node src/login.js [token]),
// this block executes.  When it is require()'d by other modules, it does not.
//
if (require.main === module) {
  const requestToken = process.argv[2]; // argv[0]=node, argv[1]=login.js, argv[2]=token
  login(requestToken).catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

// Export so other modules can use these
module.exports = { getKiteClient, readSession, createKiteClient };
