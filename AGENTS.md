# AGENTS

## Source Of Truth

- Trust `src/index.js` and `wrangler.jsonc` over `README.md` and `MedBot.md`. The prose docs lag the implementation in a few places.
- Example of stale docs: the current code does **not** use `EGQuery` for discovery anymore; it uses per-database `ESearch` counts because `EGQuery` failed in production.

## What This Repo Is

- Single Cloudflare Worker project. Entrypoint: `src/index.js`.
- Deployed Worker name is `medbot` from `wrangler.jsonc`.
- Main bindings/config live only in `wrangler.jsonc`; there is no separate test/lint/typecheck setup.

## Exact Commands

- Install deps: `npm install`
- Local dev with scheduled trigger support: `npm run dev`
- Local scheduled endpoint in dev: `http://localhost:8787/__scheduled`
- Syntax check only: `npm run check`
- Deploy: `npm run deploy`

## Verification Expectations

- There is no real test suite right now. The only built-in verification is `npm run check` (`node --check src/index.js`).
- After behavior changes, prefer a focused runtime check via the Worker routes instead of guessing:
  - `GET /health`
  - `POST /preview`
  - `POST /run`
  - `GET /last`

## Auth And Secrets

- Protected routes (`/preview`, `/run`, `/last`) require `ADMIN_TOKEN` via either `Authorization: Bearer ...` or `X-Admin-Token: ...`.
- Telegram webhook route is `POST /telegram/webhook`.
- `/telegram/webhook` optionally validates `TELEGRAM_WEBHOOK_SECRET` via `X-Telegram-Bot-Api-Secret-Token`.
- Required deploy-time secrets are described in `README.md`, but agents cannot read `.env` here; do not assume secret values are available in-tool.

## Current Runtime Defaults

- Schedule is daily at `0 6 * * *` UTC, intended for `09:00 GMT+3`.
- Current digest defaults from `wrangler.jsonc`:
  - `DIGEST_MAX_ARTICLES=5`
  - `HIGH_EVIDENCE_LIMIT=3`
  - `OBSERVATIONAL_LIMIT=2`
  - `RELATED_RECORD_LIMIT=0`
  - `ENTREZ_LOOKBACK_DAYS=2`

## Worker Gotchas

- This Worker is subrequest-sensitive. Earlier versions hit Cloudflare's "Too many subrequests by single Worker invocation" limit.
- Do not reintroduce per-candidate KV reads or broader Entrez fan-out casually. Current code postpones KV dedupe until shortlist selection via `pickUnsents()`.
- Discovery was changed away from `EGQuery` because live requests were failing; keep that in mind before "restoring" the original plan.
- Even with `RELATED_RECORD_LIMIT=0`, the current code still fetches secondary Entrez databases. If you need to reduce subrequests further, inspect the secondary search path first.

## Functional Entry Points

- Scheduled delivery path: `scheduled()` -> `runDigest()`
- Manual delivery path: `/run` -> `runDigest()`
- Telegram `/runall` uses `runDigest(..., mode: "all")` and skips the score-based selection logic.
- Preview path: `/preview` -> `runDigest()` with `deliver: false`
- Telegram chat command support is limited to `/ping`, `/run`, and `/runall` through the webhook route.

## Content Formatting

- Article output in Telegram is intentionally minimal now. Keep the article fields to:
  - `Title`
  - `Date`
  - `Journal`
  - `Type`
  - `Topic`
  - `Snippet`
  - `Record`
