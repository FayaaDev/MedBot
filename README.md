# MedBot

Cloudflare Worker that builds and sends a daily Telegram digest of recent Entrez records related to malaria, plasmodium, and anopheles.

## What It Does

- Runs daily at 06:00 UTC, which corresponds to 09:00 GMT+3.
- Uses Entrez `EGQuery` for cross-database discovery.
- Searches PubMed, PMC, and Bookshelf for digest articles.
- Searches Gene, Protein, Nucleotide, SNP, Taxonomy, and MeSH for a small related-record section.
- Scores records by evidence type, topic relevance, recency, abstract availability, and DOI metadata.
- Stores sent IDs in Workers KV so the same record is not sent twice.
- Exposes protected `/preview`, `/run`, and `/last` endpoints for manual testing.

## Files

- `src/index.js`: Worker entrypoint with scheduled and HTTP handlers
- `wrangler.jsonc`: Worker config, cron schedule, KV binding, and variables
- `MedBot.md`: implementation plan used for this Worker

## Required Secrets

Set these with `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `NCBI_API_KEY`
- `NCBI_EMAIL`
- `ADMIN_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (optional, recommended)

## KV Setup
Preview stored article keys:
npx wrangler kv key list --remote --namespace-id 0ba33a3a017b47338b67161cccdabddb --prefix "sent:"
See last run:
npx wrangler kv key get --remote --namespace-id 0ba33a3a017b47338b67161cccdabddb "run:last"

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

- `0 6 * * *` (daily at 06:00 UTC / 09:00 GMT+3)

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
- Sent IDs are kept for a year.
- Telegram messages are split automatically when a digest is too long.
- By default the Worker does not send a daily "no results" notification unless `SEND_EMPTY_DIGEST=true` is set in `vars`.
