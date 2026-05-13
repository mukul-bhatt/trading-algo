# Zerodha Trading Bot 🤖📈

A modular, beginner-friendly trading automation system built on the official **Zerodha Kite Connect API** using Node.js.

> ⚠️ **Always test with `DRY_RUN=true` before placing real orders.**

---

## Project Structure

```
zerodha-trading-bot/
│
├── config/
│   └── basket.json          ← Define your orders here (edit this!)
│
├── src/
│   ├── main.js              ← Entry point & scheduler
│   ├── login.js             ← Authentication & session management
│   ├── placeOrders.js       ← Basket order placement engine
│   ├── monitor.js           ← Live position & holdings monitor
│   ├── conditions.js        ← Strategy conditions (profit targets, stop-loss)
│   ├── websocket.js         ← Real-time Kite Ticker (live prices)
│   ├── logger.js            ← Winston logging (console + file)
│   └── utils.js             ← Shared helpers (sleep, retry, dry-run, etc.)
│
├── logs/                    ← Auto-generated log files (gitignored)
│
├── .env                     ← Your secrets (never commit this!)
├── .env.example             ← Template for .env
├── package.json
└── README.md
```

---

## Prerequisites

- **Node.js** v18 or above → [Download](https://nodejs.org/)
- A **Zerodha account** with Kite Connect access
  - Sign up for Kite Connect at [developers.kite.trade](https://developers.kite.trade/)
  - Subscription: ₹2,000/month (or ₹0 if you're a Zerodha partner/developer)
  - Create an app and note your **API Key** and **API Secret**

---

## Setup (One-Time)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
# Now edit .env with your real API key and secret
```

Your `.env` file:
```
KITE_API_KEY=your_real_key_here
KITE_API_SECRET=your_real_secret_here
DRY_RUN=true          # ← keep this true until you're confident
LOG_LEVEL=info
```

### 3. Configure your basket
Edit `config/basket.json` with the stocks and quantities you want to trade.

---

## Daily Workflow

### Step 1 — Log in (do this each morning before 9:15 AM)

```bash
node src/login.js
```

This prints a URL. Open it in your browser, log into Zerodha, and copy the `request_token` from the redirect URL.

```bash
node src/login.js  <paste-your-request-token-here>
```

A session is saved to `kite-session.json`. Valid until midnight.

---

### Step 2 — Run the bot

**Full mode** (schedules orders at 9:15 AM + monitors positions):
```bash
npm start
# or
node src/main.js
```

**Place orders right now** (manual trigger, useful for testing):
```bash
node src/main.js orders
```

**Monitor only** (no order scheduling):
```bash
node src/main.js monitor
```

---

## Basket JSON Reference

Edit `config/basket.json` to define your orders:

```json
{
  "basketName": "My Morning Basket",
  "orders": [
    {
      "tradingsymbol": "RELIANCE",
      "exchange": "NSE",
      "transaction_type": "BUY",
      "quantity": 1,
      "product": "CNC",
      "order_type": "MARKET",
      "price": null,
      "validity": "DAY",
      "tag": "my-basket-v1"
    }
  ]
}
```

### Field Reference

| Field             | Required | Values                          | Notes                                          |
|-------------------|----------|---------------------------------|------------------------------------------------|
| `tradingsymbol`   | ✅        | e.g. `"RELIANCE"`, `"INFY"`    | Exact NSE/BSE symbol                           |
| `exchange`        | ✅        | `NSE`, `BSE`, `NFO`, `MCX`     |                                                |
| `transaction_type`| ✅        | `BUY`, `SELL`                  |                                                |
| `quantity`        | ✅        | Positive integer               | Must match lot size for F&O                    |
| `product`         | ✅        | `CNC`, `MIS`, `NRML`          | CNC=delivery, MIS=intraday, NRML=F&O           |
| `order_type`      | ✅        | `MARKET`, `LIMIT`, `SL`, `SL-M`|                                               |
| `price`           | LIMIT only| e.g. `1500.00`                | Ignored for MARKET orders                      |
| `validity`        | ❌        | `DAY` (default), `IOC`        |                                                |
| `tag`             | ❌        | String ≤ 20 chars              | Identifies your bot's orders in Kite UI        |

---

## Safeguards Built In

| Safeguard                  | How it works                                                          |
|----------------------------|-----------------------------------------------------------------------|
| **Dry Run mode**           | `DRY_RUN=true` in `.env` — logs actions without placing real orders   |
| **Basket validation**      | Catches bad orders before any API call is made                        |
| **Deduplication**          | `logs/placed-YYYY-MM-DD.json` prevents placing same order twice       |
| **Retry logic**            | Failed API calls retry up to 3× with exponential back-off             |
| **Market hours check**     | Monitor pauses when market is closed                                  |
| **Graceful shutdown**      | Ctrl+C exits cleanly with a log message                               |
| **Session expiry hook**    | Clear error message when access token expires                         |

---

## Logs

| File                            | Contents                                 |
|---------------------------------|------------------------------------------|
| `logs/bot-YYYY-MM-DD.log`       | All log messages for the day             |
| `logs/errors-YYYY-MM-DD.log`    | Errors only (easy to scan)               |
| `logs/placed-YYYY-MM-DD.json`   | Record of orders placed (deduplication)  |

---

## Roadmap

| Phase | Feature                                   | Status          |
|-------|-------------------------------------------|-----------------|
| 1     | Login, basket placement, polling monitor  | ✅ Complete      |
| 2     | Auto stop-loss placement, profit booking  | 🔜 Coming next  |
| 3     | Trailing stop-loss, WebSocket conditions  | 🔜 Planned      |
| 4     | Dashboard, Telegram alerts                | 🔜 Planned      |

---

## Important Warnings

> ⚠️ **This software is for educational purposes. Trading involves financial risk. Always verify orders manually before going live.**

- Never commit your `.env` file to git
- The `kite-session.json` file contains your live access token — keep it private
- Start with small quantities when going live for the first time
- Always verify on the Kite UI that orders placed by the bot are correct

---

## Author

**Mukul Bhatt** | Built with Kite Connect API
