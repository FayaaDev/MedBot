# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup

```bash
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required `.env` variables:
- `SEHA_ID` — SEHA portal national ID / Iqama number
- `SEHA_PW` — SEHA portal password
- `N8N_OTP_URL` — OTP API endpoint URL
- `N8N_OTP_API_KEY` — OTP API bearer token
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (from @BotFather)
- `TELEGRAM_CHAT_ID` — Admin's Telegram chat ID

Optional `.env` variables:
- `N8N_OTP_METHOD` — HTTP method for OTP fetch (default: `GET`)
- `N8N_OTP_TIMEOUT_MS` — OTP request timeout in ms (default: `60000`)
- `N8N_OTP_MAX_AGE_SECONDS` — reject OTPs older than this many seconds (default: `120`)
- `N8N_OTP_BODY` — JSON body for POST requests
- `N8N_OTP_DEBUG` — set to `true` for verbose OTP fetch logging
- `SEHA_MAX_EXPORT_ATTEMPTS` — max export retry attempts (default: `5`)

## Running

**One-off run (from terminal):**
```bash
node sehax.js
```
Runs with a visible browser window (headed mode).

**Persistent scheduled runs (recommended):**
```bash
# Start the Telegram bot
pm2 start bot.js --name "cholera-bot"

# Start the hourly scheduler (runs sehax.js every hour at :45)
pm2 start scheduler.js --name "cholera-sehax"

# Save so both survive reboots
pm2 save
pm2 startup  # follow the printed instruction once
```

## Architecture

### Files
- **`sehax.js`** — SEHA portal automation: logs in, downloads today's investigation report, parses it, deduplicates via SQLite, and sends Telegram notifications
- **`bot.js`** — Telegram bot: user access control (approve/revoke/block), per-user disease subscriptions
- **`scheduler.js`** — Keeps `sehax.js` running on a schedule via pm2 (fires every hour at :45)
- **`cases.db`** — SQLite database (auto-created): `seen_cases`, `diseases`, `subscriptions`, `users` tables

### sehax.js Flow
1. **Lock** — writes `sehax.lock` with PID; exits if another instance is running
2. **Login** — navigates to `seha.sa`, fills credentials from `.env`
3. **OTP** — clicks SMS OTP button, waits 30s, polls `fetchN8nOtp()` every 5s for up to 1 minute
4. **Navigation** — expands "ادارة نظام حصن" sidebar, clicks "مدير حصن لوحدة التقصيات", then "حصن بلس"
5. **Export** — inside `#contentIframe`, opens "وحدة التقصيات" → "التقصيات", sets today's date range, searches, exports via `exportWithRetry()`
6. **Notify** — parses XLSX, deduplicates against `seen_cases`, notifies each subscribed user via Telegram, deletes the file
7. **Teardown** — closes browser, releases lock, exits

### bot.js Features
- Admin-only access control: approve, revoke, block users
- Blocked users list (separate from main users list)
- Per-user disease subscriptions with 2-column inline keyboard (20 diseases/page)
- Admin keyboard: `[👥 المستخدمون] [🚫 المحظورون] / [🦠 الأمراض] [📋 اشتراكاتي]`
- User keyboard: `[🦠 الأمراض] [📋 اشتراكاتي]`

### Key Helpers
- `exportWithRetry()` — clicks export button, waits for Playwright download event; checks for session expiry after 3 failed attempts
- `fetchN8nOtp()` — HTTP GET/POST to OTP API; parses JSON `otp`/`OTP`/`code` fields or regex scans raw body
- `selectFromChoicesByText()` — opens a Choices.js dropdown, types to filter, clicks matching option
- `setDateInColumn()` — fills a date input and fires `input`/`change` events for framework reactivity
- `syncLog()` — writes errors synchronously to log file so nothing is lost on crash

### Safeguards
- **Process lock file** (`sehax.lock`) — prevents multiple simultaneous runs
- **25-minute global timeout** — force-exits any hung process
- **Session expiry detection** — aborts export if page redirected to login
- **`SEHA_MAX_EXPORT_ATTEMPTS=5`** — gives up after 5 failed export attempts instead of looping forever
- **Headless mode from scheduler** — no GUI/window server dependency when run non-interactively
