# MedBot

A telegram bot that sends daily recent articles based on predefined criteria. It uses Entrez API which gives access to a number of databases including PubMed.

## What It Does

- Runs daily at 09:00 GMT+3.
- Uses Entrez `EGQuery` for cross-database discovery.
- Searches PubMed, PMC, and Bookshelf for digest articles.
- Scores records by evidence type, topic relevance, recency, abstract availability, and DOI metadata.
- Loads active search keywords from Workers KV so they can be changed without redeploying.
- Stores sent IDs in Workers KV so the same record is not sent twice.
- Exposes protected `/preview`, `/run`, and `/last` endpoints for manual testing.

## Files

- `src/index.js`: Worker entrypoint with scheduled and HTTP handlers
- `wrangler.jsonc`: Worker config, cron schedule, KV binding, and variables

## Required Secrets

Set these with `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (required for scheduled/manual digest delivery, not for public `/ping` access)
- `NCBI_API_KEY`
- `NCBI_EMAIL`
- `ADMIN_TOKEN`

## KV Setup
Active keywords are stored in `MEDBOT_KV` under `config:keywords`.

Example value:

```json
{
  "version": 1,
  "terms": ["malaria", "dengue"],
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

- `0 6 * * *` (daily at 09:00 GMT+3)

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

## Telegram Command

- `/ping`: replies with `pong`
- `/start`: triggers a manual digest run in the configured `TELEGRAM_CHAT_ID`
- `/keywords`: shows the active keywords, topic signature, and whether they came from KV or fallback defaults
- `/setkeywords malaria, dengue`: replaces the active keyword list in Workers KV
- `Change keyword`: shows the active keywords and the `/setkeywords` usage

The bot includes a reply keyboard with `/start`, `/ping`, and `Change keyword` buttons on its chat responses.

To enable the chat command, point your Telegram bot webhook at:

```text
https://<your-worker-domain>/telegram/webhook
```

If you set `TELEGRAM_WEBHOOK_SECRET`, configure the Telegram webhook with the same secret token.

The bot accepts Telegram commands from any chat. `/ping`, `/keywords`, and `Change keyword` reply in the caller's chat; `/start` triggers digest delivery to the configured `TELEGRAM_CHAT_ID`.

`/setkeywords` is restricted to the configured `TELEGRAM_CHAT_ID` and replaces the full active keyword list. Example:

```text
/setkeywords malaria, dengue, tuberculosis
```

These responses include reply keyboard buttons for `/start`, `/ping`, and `Change keyword`.

## Notes

- The Worker expects a KV binding named `MEDBOT_KV`.
