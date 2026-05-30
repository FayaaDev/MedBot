# MedBot

A telegram bot that sends daily recent articles based on predefined criteria. It uses Entrez API which gives access to a number of databases including PubMed. 
In this version, the bot is programmed to retrieve Malaria articles.

## What It Does

- Runs daily at 09:00 GMT+3.
- Uses Entrez `EGQuery` for cross-database discovery.
- Searches PubMed, PMC, and Bookshelf for digest articles.
- Scores records by evidence type, topic relevance, recency, abstract availability, and DOI metadata.
- Stores sent IDs in Workers KV so the same record is not sent twice.
- Exposes protected `/preview`, `/run`, and `/last` endpoints for manual testing.

## Files

- `src/index.js`: Worker entrypoint with scheduled and HTTP handlers
- `wrangler.jsonc`: Worker config, cron schedule, KV binding, and variables

## Required Secrets

Set these with `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `NCBI_API_KEY`
- `NCBI_EMAIL`
- `ADMIN_TOKEN`

## KV Setup
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
- `/run`: triggers a manual digest run in the configured Telegram chat
- `/runall`: triggers a manual digest run that skips scoring and sends any matching primary articles

To enable the chat command, point your Telegram bot webhook at:

```text
https://<your-worker-domain>/telegram/webhook
```

If you set `TELEGRAM_WEBHOOK_SECRET`, configure the Telegram webhook with the same secret token.

## Notes

- The Worker expects a KV binding named `MEDBOT_KV`.
