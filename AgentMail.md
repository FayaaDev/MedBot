# AgentMail Integration Plan

## Goal

Add daily email delivery through AgentMail alongside the existing Telegram delivery path, using the current AgentMail inbox ID and a small mailing list.

## Constraints From Current Code

- The scheduled path and manual `/run` path both flow through `runDigest()` in `src/index.js`.
- Digest generation and digest delivery are already separated.
- Telegram sending currently happens only after a digest is built and before records are marked as sent.
- Sent-record dedupe must remain intact.
- This Worker currently uses direct `fetch` calls instead of external SDK dependencies.

## Implementation Approach

### 1. Extend delivery configuration

Add AgentMail-specific configuration in `getConfig()`.

Required secrets/vars:

- `AGENTMAIL_API_KEY`
- `AGENTMAIL_INBOX_ID`
- `AGENTMAIL_TO_EMAILS`

Optional vars:

- `AGENTMAIL_ENABLED` default `true`
- `AGENTMAIL_SUBJECT_PREFIX` for environment-specific prefixes like `[Preview]`

Notes:

- `AGENTMAIL_TO_EMAILS` should be a comma-separated list for the small mailing list.
- Keep Telegram config unchanged so the existing bot continues to work.

### 2. Add an AgentMail client helper

Create a small helper that sends authenticated requests to AgentMail using `fetch`.

Planned helper shape:

- `createAgentMailClient(config)`
- `agentMail.sendMessage({ to, subject, text, html })`

Implementation details:

- Use direct HTTP requests to AgentMail instead of installing the AgentMail SDK.
- Send `Authorization: Bearer <AGENTMAIL_API_KEY>`.
- Target the inbox send endpoint for the configured inbox ID.
- Parse error responses and throw clear failures for observability.

### 3. Reuse the current digest text for the email text body

Keep `formatDigest()` as the source for the plain-text email body.

Benefits:

- No change to scoring, selection, or article formatting logic.
- Telegram and email stay consistent.
- Preview and stored run output remain easy to compare.

### 4. Add a dedicated HTML email formatter

Add a small HTML formatter for the same digest content.

Requirements:

- Use the same article fields already used in Telegram output:
  - `Title`
  - `Date`
  - `Journal`
  - `Type`
  - `Topic`
  - `Snippet`
  - `Record`
- Keep the markup simple and email-client-friendly.
- Include both section headings and the discovery summary.
- Escape dynamic content safely before rendering HTML.

Suggested output shape:

- Short title/header
- One section for `Analytic Studies`
- One section for `Observational Studies`
- Ordered article blocks with key-value metadata
- Footer lines for lookback window and signal snapshot

### 5. Send email alongside Telegram in `runDigest()`

Update `runDigest()` so that when `deliver` is true and there is a non-empty digest body:

- Send the Telegram digest
- Send the AgentMail digest
- Mark records as sent only after both deliveries succeed

Recommended behavior:

- Delivery is all-or-nothing for scheduled and manual runs.
- If either Telegram or AgentMail fails, throw and do not mark records as sent.

Reasoning:

- This preserves current dedupe semantics.
- It avoids a partial-delivery state where one channel sends but the digest becomes permanently skipped.

### 6. Expand stored run metadata

Extend the stored result payload for `/last` and KV diagnostics.

Suggested fields:

- `telegramSentMessages`
- `emailSent`
- `emailRecipients`
- `emailSubject`
- `agentMailMessageId` or a compact API response identifier if available

Keep existing fields like `sentRecords`, `summary`, `messageText`, and `selectedCounts`.

### 7. Preserve preview behavior

`/preview` should continue building the digest without sending Telegram or email.

Optional later improvement:

- Add a separate preview mode that returns both `messageText` and rendered HTML for email QA.

This is not required for the first integration pass.

### 8. Update deployment and configuration docs

Update:

- `README.md`
- `.env.example` if it is used locally
- `wrangler.jsonc` only for non-secret defaults, if any are needed

Document:

- new AgentMail secrets/vars
- comma-separated mailing list format
- delivery behavior alongside Telegram
- expected verification flow

### 9. Verify with focused runtime checks

Minimum verification:

1. `npm run check`
2. `POST /preview` to confirm digest generation still works
3. `POST /run` with AgentMail configured to verify both Telegram and email delivery
4. `GET /last` to confirm the stored metadata includes both delivery channels

Practical rollout:

- Test first with a single recipient from the mailing list.
- Expand to the full small mailing list once formatting and delivery are confirmed.

## Proposed Data Model Changes

### New config fields

- `agentMailEnabled`
- `agentMailInboxId`
- `agentMailApiKey`
- `agentMailRecipients`
- `agentMailSubjectPrefix`

### New helper functions

- `createAgentMailClient(config)`
- `sendAgentMailDigest(agentMail, recipients, digest, context)`
- `formatDigestHtml(selection, discovery, config, mode)` or `formatDigestEmailHtml(digest, config)`
- `escapeHtml(value)`
- `parseCsvList(value)`

## Recommended Order Of Work

1. Add config parsing for AgentMail settings.
2. Add recipient parsing and validation.
3. Add the AgentMail HTTP helper.
4. Add HTML email formatting.
5. Integrate email send into `runDigest()`.
6. Expand stored result metadata.
7. Update docs.
8. Run syntax and route-level verification.

## Non-Goals For First Pass

- Receiving inbound email in this Worker
- AgentMail webhooks
- Reply threading or human-in-the-loop flows
- Per-recipient personalization
- Partial success retry queues
- Migrating Telegram formatting to HTML-first generation

## Open Decisions Already Resolved

- Delivery channel behavior: send alongside Telegram
- Audience shape: small mailing list
- Inbox provisioning: existing AgentMail inbox ID will be used

## Suggested Commit Scope For Implementation

The implementation can stay in a single Worker file for the first pass, since the codebase is currently centered in `src/index.js` and the change is still narrow in scope.
