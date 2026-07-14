# MedBot

A telegram bot that sends recent articles to approved subscribers. Each approved user can manage their own keywords and daily delivery time. It uses Entrez API which gives access to a number of databases including PubMed.

## What It Does

- Checks every minute for users whose Saudi-time schedule is due.
- Uses Entrez `EGQuery` for cross-database discovery.
- Searches PubMed, PMC, and Bookshelf for digest articles.
- Scores records by evidence type, topic relevance, recency, abstract availability, and DOI metadata.
- Stores per-user search keywords and schedules in Workers KV so they can be changed without redeploying.
- Stores sent IDs in Workers KV so the same record is not sent twice.
- Exposes protected `/preview`, `/run`, and `/last` endpoints for manual testing.

## Files

- `src/index.js`: Worker entrypoint with scheduled and HTTP handlers
- `wrangler.jsonc`: Worker config, cron schedule, KV binding, and variables

## Required Secrets

Set these with `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (admin Telegram chat ID used for approvals)
- `NCBI_API_KEY`
- `NCBI_EMAIL`
- `ADMIN_TOKEN`

## KV Setup
Subscriber data is stored in `MEDBOT_KV` under per-user keys such as `user:<chatId>`, `user:<chatId>:keywords`, and `user:<chatId>:schedule`.

The older global keyword key `config:keywords` is still used by the protected HTTP preview/run flow when no `chatId` is supplied.

Example value:

```json
{
  "version": 1,
  "terms": ["dengue, vaccine", "malaria, treatment"],
  "updatedAt": "2026-06-15T09:00:00.000Z",
  "updatedBy": "telegram:<chatId>"
}
```

Preview stored article keys:
npx wrangler kv key list --remote --namespace-id xxx --prefix "sent:"
See last run:
npx wrangler kv key get --remote --namespace-id xxx "run:last"

Create a KV namespace and put its ID into `wrangler.jsonc`:

```bash
wrangler kv namespace create MEDBOT_KV
```

Then replace the placeholder `id` value under `kv_namespaces`.

## Local Dev

```bash
npm install
npm run dev
```

With scheduled testing enabled, Wrangler exposes `http://localhost:8787/__scheduled`.

Current production schedule:

- `* * * * *` (checks each minute for due subscribers)

Protected routes require one of:

- `Authorization: Bearer <ADMIN_TOKEN>`
- `X-Admin-Token: <ADMIN_TOKEN>`

## Deploy

```bash
npm run deploy
```

## HTTP Routes

- `GET /health`: basic status and config summary
- `GET /ping`: simple liveness check returning `pong`
- `POST /preview`: build digest without sending to Telegram
- `POST /run`: build digest and send it immediately
- `GET /last`: return the last stored digest payload from KV
- `POST /telegram/webhook`: Telegram webhook endpoint

## Telegram Commands

- `/ping`: replies with `pong`
- `/join`: requests access from the admin
- `Keywords`: shows the caller's current keywords, then asks whether to replace them
- `Schedule`: updates the caller's daily delivery time in `Asia/Riyadh`
- `My Settings`: shows the caller's current keyword and schedule settings
- `Run Now`: presents 30-day, 1-year, and 5-year choices before manually fetching articles for the caller
- `Users` and `Pending`: admin-only subscriber lists with approve/reject buttons

Approved users get a reply keyboard with `Keywords`, `Schedule`, `My Settings`, and `Run Now`. `Run Now` only affects that manual request: scheduled digests continue to use the configured lookback window. Manual searches return up to 10 unsent articles; longer ranges search a larger bounded candidate pool. The admin also gets `Users` and `Pending`.

To enable the chat command, point your Telegram bot webhook at:

```text
https://<your-worker-domain>/telegram/webhook
```

If you set `TELEGRAM_WEBHOOK_SECRET`, configure the Telegram webhook with the same secret token.

The bot accepts Telegram messages from any chat. Users must send `/join` and be approved by the admin before they can manage keywords, set schedules, or fetch articles.

When an approved user sends `Keywords`, the bot shows the current keyword list and asks for a `yes` or `no` reply. If the user replies `yes`, the bot asks for the replacement queries. Commas mean `AND` inside one query. Use semicolons or new lines to set multiple queries. Example:

```text
dengue, vaccine; malaria, treatment
```

After keywords are updated, the bot asks for a daily `HH:MM` schedule in `Asia/Riyadh`.

## Notes

- The Worker expects a KV binding named `MEDBOT_KV`.
