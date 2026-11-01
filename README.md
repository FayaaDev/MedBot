# MedBot

A Telegram bot for personalized medical-literature digests and reference exports. A Cloudflare Worker searches PubMed, PubMed Central (PMC), and optionally Web of Science, then delivers articles to approved subscribers. A separate Python service converts selected references from review articles into a CSV ready for [ASReview](https://asreview.nl/).

## Features

- Per-user keywords and daily delivery schedules in Saudi time (`Asia/Riyadh`).
- One-time searches over 30 days, 1 year, or 5 years without changing saved settings.
- Article selection ranked by publication-type signals, then publication date.
- Per-user sent-record tracking in Workers KV.
- Admin approval of subscribers through Telegram.
- PDF, article URL, or DOI submission for reference extraction and CSV delivery.
- Protected HTTP endpoints for previewing, running, and inspecting digests.

## Architecture

```text
Telegram messages ──► Cloudflare Worker ──► NCBI Entrez / Web of Science
Minute cron ────────►        │
                            ├── Workers KV: users, settings, history
                            ├── Telegram: article delivery
                            └── Python review processor ──► Telegram: CSV
```

The Worker and review processor are deployed separately. The processor is only needed for **Review Articles**.

## Requirements

- Bun for Worker dependencies and commands.
- A Cloudflare account with Workers and KV access.
- A Telegram bot token and the admin's Telegram chat ID.
- An NCBI contact email; an NCBI API key is optional.
- Optional: a Web of Science Starter API key.
- Optional: Docker for the review processor, and uv for its local Python tests or CLI.

## Worker setup

Run commands from the repository root unless stated otherwise.

### 1. Install dependencies and authenticate

```bash
bun install
bunx wrangler login
```

### 2. Configure Workers KV

Create a namespace for your deployment:

```bash
bunx wrangler kv namespace create MEDBOT_KV
```

Replace the existing `kv_namespaces[0].id` in `wrangler.jsonc` with the returned namespace ID. Keep the binding name `MEDBOT_KV`.

### 3. Configure credentials

Set the secrets used by a full Telegram digest deployment:

```bash
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler secret put NCBI_EMAIL
bunx wrangler secret put ADMIN_TOKEN
```

| Setting | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API access and message delivery. |
| `TELEGRAM_CHAT_ID` | Admin identity for approvals; default destination for HTTP runs without `chatId`. |
| `NCBI_EMAIL` | Contact email required by the Entrez client for digest searches. |
| `ADMIN_TOKEN` | Authentication for `/preview`, `/run`, and `/last`. |
| `NCBI_API_KEY` | Optional NCBI API key. |
| `WOS_STARTER_API_KEY` | Optional Web of Science Starter key; without it, that source is skipped. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional shared secret validated on incoming Telegram webhooks. |
| `ASREVIEW_TOKEN` | Required for Review Articles; must match the processor token. |

Use `bunx wrangler secret put <NAME>` for optional secrets as needed. Configure the review processor's public HTTPS origin as `ASREVIEW_URL` in `wrangler.jsonc`; replace the repository's deployment-specific value for your own installation.

For local development, create a git-ignored `.dev.vars` file using the credential names in `.env.example`. Populate the values needed by the features you are testing. Add `TELEGRAM_WEBHOOK_SECRET` if you use webhook validation.

### 4. Run locally

```bash
bunx wrangler dev --test-scheduled
```

Wrangler uses local KV storage for development. Check liveness and inspect configuration with:

```bash
curl http://localhost:8787/ping
curl http://localhost:8787/health
```

The local scheduled-trigger endpoint is `http://localhost:8787/__scheduled`. Invoking it checks for due users and can send real Telegram messages when delivery credentials are configured.

### 5. Deploy

```bash
bunx wrangler deploy
```

The configured Worker name is `medbot`. Register the deployed webhook with Telegram using credentials loaded into your shell:

```bash
export WORKER_URL='https://<your-worker-domain>'

curl --fail-with-body -sS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

If no webhook secret is configured, omit the `secret_token` argument. When configured, its value must match the Worker's `TELEGRAM_WEBHOOK_SECRET`.

## Using the bot

Send `/join` to request access. The admin receives approval controls; approved users are prompted to set keywords and a daily delivery time.

The main menu offers three workflows:

### Cron

Manage saved keywords, schedule, and manual delivery:

| Command / button | Action |
| --- | --- |
| `/keywords` / **Keywords** | Show saved queries and confirm whether to replace them. |
| `/schedule` / **Schedule** | Set a daily `HH:MM` delivery time in `Asia/Riyadh`. |
| `/settings` / **My Settings** | Show saved keywords and schedule. |
| `/runnow` / **Run Now** | Search saved keywords over 30 days, 1 year, or 5 years. |
| `/stop` / **Stop** | Disable scheduled delivery. |

Commas combine terms with **AND** within a query. Semicolons or newlines separate queries. For example:

```text
dengue, vaccine; malaria, treatment
```

This searches for dengue AND vaccine, and separately malaria AND treatment. Up to 10 distinct queries are accepted. Saving keywords prompts for a schedule.

The cron trigger runs every minute and dispatches approved users' enabled schedules when due. **Run Now** uses normal sent-record tracking and does not change the scheduled search window.

### One-time

Enter temporary keywords, then choose **30 days**, **1 year**, or **5 years**. Results use the normal scoring and article cap. This workflow does not change saved keywords, schedules, digest history, or scheduled-delivery deduplication; previously delivered articles can appear again.

### Review Articles

1. Choose **Review Articles** or send `/review`.
2. Upload a text-based PDF, send a public article/PDF URL, or enter a DOI.
3. Supply the reference numbers to include, such as `15-25,31`.
4. The processor sends an ASReview-ready CSV or a processing error to Telegram asynchronously.

PDF uploads are limited to 19 MiB at the Worker. The extractor requires bracket-numbered references such as `[15]`; it does not perform OCR, identify included studies automatically, or write a narrative review. Article URLs may fail to resolve when PDFs are paywalled or require JavaScript.

Review conversations accept `cancel` or `/cancel`. Conversation state expires after 10 minutes. `/menu` clears the current flow and returns to the main menu.

### Admin controls

- `/users` / **Users**: list subscribers with approval controls.
- `/pending` / **Pending**: list access requests.
- `/ping`: reply with `pong`; also available before approval.

## Search and delivery behavior

Discovery uses per-database Entrez `ESearch` counts and searches PubMed and PMC for candidates. Web of Science Starter adds candidates when enabled and configured with an API key.

Publication-type rules prioritize randomized trials, meta-analyses, systematic reviews, and other clinical trials, followed by observational studies. Remaining capacity can be filled by unclassified records. These are metadata-based ranking signals, not a critical appraisal of study quality.

Each article includes its title, date, journal, evidence type when available, matching topic, snippet, and source record link.

Sent-record keys are scoped to the user and keyword signature and retained for 366 days. Records are marked sent after successful delivery. Changing the keyword signature changes the deduplication scope. Identity is based on database and record ID, so the same article can appear from multiple sources.

### Configured defaults

These values come from `wrangler.jsonc`; code-level fallbacks differ if variables are omitted.

| Variable | Value | Purpose |
| --- | --- | --- |
| `DIGEST_MAX_ARTICLES` | `10` | Overall article cap. |
| `HIGH_EVIDENCE_LIMIT` | `6` | High-evidence selection quota. |
| `OBSERVATIONAL_LIMIT` | `4` | Observational selection quota. |
| `ENTREZ_LOOKBACK_DAYS` | `14` | Scheduled and HTTP search window. |
| `SEND_EMPTY_DIGEST` | `true` | Send a message when no articles are selected. |
| `NCBI_TOOL` | `MedBot` | NCBI client identifier. |
| `WOS_ENABLED` | `true` | Enable Web of Science when a key is present. |
| `WOS_DB` | `WOS` | Web of Science database. |
| `WOS_RETMAX` | `10` | Default Web of Science candidate limit per query. |
| `WOS_SORT` | `LD+D` | Web of Science sort expression. |

Without saved keywords, searches fall back to separate `malaria` and `plasmodium` queries. Candidate retrieval is bounded; longer manual ranges increase the candidate pool but do not return every matching record.

## HTTP API

| Method | Route | Authentication | Behavior |
| --- | --- | --- | --- |
| `GET` | `/ping` | Public | Plain-text `pong`. |
| `GET` | `/health` | Public | Global configuration and last-run summary; not an upstream connectivity check. |
| `POST` | `/preview` | Admin token | Build and store a digest without sending or marking records sent. |
| `POST` | `/run` | Admin token | Build, store, and deliver a digest. |
| `GET` | `/last` | Admin token | Retrieve the last stored digest, or `null`. |
| `POST` | `/telegram/webhook` | Optional webhook secret | Handle Telegram messages and callback queries. |

Protected routes accept `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Token: <ADMIN_TOKEN>`.

```bash
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$WORKER_URL/preview?chatId=123456789"

curl --fail-with-body -sS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$WORKER_URL/last?chatId=123456789"
```

The optional `chatId` query parameter selects that user's saved keywords and history for `/preview`, `/run`, and `/last`. Without it, these routes use global keywords and history; `/run` sends to `TELEGRAM_CHAT_ID`. Request bodies do not override keywords, dates, or limits. Previews update stored digest history even though they do not deliver messages.

## Review processor

Build and run the optional service from `asreview/`, with `ASREVIEW_TOKEN` set in your shell:

```bash
docker build -t medbot-review .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e ASREVIEW_TOKEN medbot-review
```

Expose it through a trusted HTTPS endpoint reachable by the Worker, set `ASREVIEW_URL` to that origin, and set the matching Worker secret `ASREVIEW_TOKEN`. The Worker submits to `POST /process` and passes the Telegram bot token for result delivery; avoid request-body logging.

Accepted jobs run in memory. Restarting the container loses unfinished jobs. Only references with detected DOIs are included in metadata enrichment, and unavailable metadata can leave CSV fields blank.

See [asreview/README.md](asreview/README.md) for the processor API, CLI usage, CSV schema, extraction limits, and metadata lookup behavior. Deploying the Worker does not update this service; rebuild and redeploy it separately after processor changes.

## Verification

Worker syntax and tests, from the repository root:

```bash
bun run check
bun test
```

Processor tests, from `asreview/`:

```bash
uv run --no-project python -m unittest test_asreview test_server -v
```

After deployment, check `/health`, use `/preview` with an admin token, and inspect `/last`. Use `/run` when you want to verify actual Telegram delivery.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/index.js` | Worker HTTP handlers, Telegram flows, scheduling, search, and delivery. |
| `wrangler.jsonc` | Worker configuration, KV binding, cron trigger, and runtime variables. |
| `test/` | Worker regression tests. |
| `asreview/` | Python reference extractor, HTTP processor, Dockerfile, and tests. |
| `scripts/` | Maintenance scripts. |
| `.env.example` | Credential names for local configuration. |

Runtime state lives in `MEDBOT_KV`, including user profiles, keywords, schedules, conversation state, sent records, digest history, and the last recorded error. The implementation in `src/index.js` and configuration in `wrangler.jsonc` are the source of truth.
