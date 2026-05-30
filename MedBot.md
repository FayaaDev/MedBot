# MedBot Plan

## Goal

Build a Cloudflare Worker-based Telegram bot that sends one weekly Entrez digest every Sunday with selected, reputable articles and research outputs related to:

- Malaria
- Plasmodium
- Anopheles

The bot should prefer high-evidence studies first, then notable observational studies.

## Core Behavior

- Runs once per week on Sunday.
- Searches across all Entrez databases, not just PubMed.
- Prioritizes literature/article databases for the final digest, while still using broader Entrez discovery to catch relevant cross-database records.
- Scores and filters results using evidence quality, topic relevance, publication type, and metadata quality.
- Sends one Telegram digest containing the chosen articles.
- Stores already-sent record IDs to avoid duplicate alerts.
- Uses broader scoring instead of a strict journal whitelist.

## Hosting

The bot will be hosted as a Cloudflare Worker.

Cloudflare components:

- Worker for scheduled execution and Telegram delivery.
- Cron Trigger for the Sunday schedule.
- Workers KV for deduplication and lightweight state.
- Worker Secrets for Telegram and NCBI credentials.

Default schedule:

```text
0 9 * * SUN
```

This means every Sunday at 09:00 UTC. Cloudflare cron triggers run in UTC, so the final deployment should confirm the desired local notification time.

## Data Sources

Primary data source:

```text
NCBI Entrez E-utilities
```

Base URL:

```text
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
```

The bot should treat Entrez in two layers:

1. Global discovery across Entrez.
2. Digest assembly from databases that can produce article-like or human-readable research records.

### Global Discovery Layer

Use Entrez-wide discovery to identify where topic activity exists.

Candidate databases include:

- PubMed
- PMC
- Bookshelf
- Gene
- Protein
- Nucleotide
- Genome
- SNP
- Taxonomy
- Structure
- MeSH

### Digest Assembly Layer

The final weekly Telegram digest should prioritize records from databases that can be presented as readable research items.

Primary digest sources:

- PubMed
- PMC
- Bookshelf when relevant

Secondary enrichment sources:

- Gene
- Protein
- Nucleotide
- SNP
- Taxonomy
- MeSH

These secondary sources should enrich the digest or support a short "related records" section, but should not overwhelm the article-focused output.

## Main Entrez Endpoints

| Endpoint | Purpose |
|---|---|
| `EGQuery` | Get counts across Entrez databases for a topic |
| `EInfo` | Inspect fields and capabilities for a database |
| `ESearch` | Find matching IDs within each database |
| `ESummary` | Retrieve summary metadata |
| `EFetch` | Retrieve richer XML data |
| `ELink` | Link literature records to related data in other Entrez databases |

## Entrez API Requirements

The Worker should include these parameters in Entrez requests:

| Parameter | Purpose |
|---|---|
| `tool` | Identifies this application, e.g. `MedBot` |
| `email` | Developer contact email |
| `api_key` | NCBI API key for higher request allowance |
| `retmode=json` | Used for `EGQuery`, `ESearch`, and `ESummary` where possible |
| `retmode=xml` | Used for `EFetch` when richer parsing is needed |

Rate-limit handling:

- Without an API key, keep requests at or below 3 requests per second.
- With an API key, keep requests at or below 10 requests per second.
- Add request spacing anyway to avoid accidental bursts.
- Batch IDs instead of fetching one record at a time.

## Search Strategy

Use separate queries for each topic, then run them across the selected Entrez databases.

### Topic Queries

#### Malaria Query

```text
(malaria[MeSH Terms] OR malaria[Title/Abstract])
```

#### Plasmodium Query

```text
(Plasmodium[MeSH Terms] OR Plasmodium[Title/Abstract] OR "Plasmodium falciparum"[Title/Abstract] OR "Plasmodium vivax"[Title/Abstract])
```

#### Anopheles Query

```text
(Anopheles[MeSH Terms] OR Anopheles[Title/Abstract])
```

### Cross-Database Search Flow

1. Run `EGQuery` for each topic to measure where matches exist across Entrez.
2. Run `ESearch` in the selected databases that are likely to return useful results.
3. Merge and deduplicate IDs by database.
4. Prioritize literature databases first.
5. Optionally use `ELink` to connect PubMed or PMC records to related Gene, Protein, Nucleotide, or Taxonomy records.

### Date Window

Use a slightly wider window than exactly 7 days to avoid missing records because of indexing delay.

Recommended:

```text
reldate=10&datetype=pdat
```

The bot will still deduplicate by database plus record ID, so a wider window should not create repeated Telegram alerts.

## Evidence Preference

Preferred high-evidence article types:

| Priority | Publication Type |
|---|---|
| Highest | Guideline |
| Highest | Practice Guideline |
| High | Systematic Review |
| High | Meta-Analysis |
| High | Randomized Controlled Trial |
| High | Controlled Clinical Trial |
| Medium | Clinical Trial |
| Medium | Multicenter Study |

Secondary observational article types:

| Priority | Publication Type |
|---|---|
| Secondary | Observational Study |
| Secondary | Cohort Study |
| Secondary | Case-Control Study |
| Secondary | Cross-Sectional Study |
| Secondary | Epidemiologic Study |

Lower-priority or excluded article types:

| Treatment | Publication Type |
|---|---|
| Exclude by default | Editorial |
| Exclude by default | Comment |
| Exclude by default | Letter |
| Exclude by default | News |
| Deprioritize | Case Reports |
| Deprioritize | Narrative Review |

For non-literature Entrez databases, use a lighter relevance score and only surface them if they strongly support one of the selected digest articles or represent a notable weekly signal.

## Scoring Model

The bot will use broader scoring instead of a journal whitelist.

Suggested scoring:

| Signal | Score |
|---|---:|
| Guideline or Practice Guideline | +50 |
| Systematic Review | +40 |
| Meta-Analysis | +40 |
| Randomized Controlled Trial | +35 |
| Controlled Clinical Trial | +30 |
| Clinical Trial | +25 |
| Observational Study | +18 |
| Cohort / Case-Control / Cross-Sectional / Epidemiologic Study | +15 |
| Topic term appears in title | +15 |
| Multiple target topics matched | +10 |
| Abstract is available | +8 |
| Has DOI | +5 |
| Published in the last 10 days | +5 |
| Strong linked-record support through `ELink` | +5 |
| Editorial / Comment / Letter / News | -100 |
| Case Report | -20 |
| No abstract | -10 |

Selection logic:

- Sort by total score descending.
- Prefer high-evidence items first.
- Include observational studies only after high-evidence items.
- Avoid sending low-score items unless there are too few high-quality results.
- Deduplicate across overlapping topic queries and across database-specific searches.

Default weekly digest size:

| Category | Max Items |
|---|---:|
| High-evidence articles | 10 |
| Observational/notable articles | 5 |
| Related non-literature records | 3 |
| Total default maximum | 18 |

## Reputability Approach

Entrez does not provide a reliable `peer_reviewed=true` field.

The bot will approximate reputability using:

- Entrez indexing as a baseline signal.
- Publication type.
- Study design.
- Presence of abstract and DOI.
- Relevance to target topic.
- Exclusion of editorials, comments, letters, and news.
- Optional linked support from other Entrez databases.

The first version will avoid impact factor, citation count, or author reputation because Entrez does not reliably provide those as structured fields across databases.

## Weekly Digest Format

Telegram message title:

```text
MedBot Weekly Digest: Malaria, Plasmodium, Anopheles
```

Digest structure:

1. High-evidence articles
2. Notable observational studies
3. Related Entrez records

Each article should include:

- Rank
- Title
- Source database
- Journal or source
- Publication date
- Evidence type
- Matched topic
- Score
- Authors, shortened to first author plus “et al.”
- Short abstract or summary snippet
- PubMed, PMC, or source record link
- DOI link if available

Example item:

```text
1. Insecticide resistance patterns in Anopheles gambiae populations...
Source: PubMed
Journal: Malaria Journal
Date: 2026-05-24
Type: Observational Study
Topic: Anopheles
Score: 48

Why selected: topic in title, abstract available, observational vector-control evidence.

PubMed: https://pubmed.ncbi.nlm.nih.gov/12345678/
DOI: https://doi.org/...
```

Example related-record item:

```text
Related record: Gene
Gene: pfcrt
Reason: linked to multiple selected malaria articles this week.
```

If no articles pass the threshold:

```text
No high-signal Entrez records matched this week for Malaria, Plasmodium, or Anopheles.
```

## Storage Design

Use Workers KV for MVP.

KV keys:

| Key Pattern | Purpose |
|---|---|
| `sent:<db>:<id>` | Tracks records already sent |
| `run:last` | Last successful run timestamp |
| `digest:<yyyy-mm-dd>` | Optional stored copy of weekly digest |
| `config:queries` | Optional query configuration |
| `error:last` | Last error summary for debugging |

Deduplication rule:

- Only mark records as sent after Telegram delivery succeeds.
- If Telegram fails, do not mark records as sent.
- Keep sent record IDs for at least 1 year.

## Secrets and Configuration

Worker secrets:

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token |
| `TELEGRAM_CHAT_ID` | Target Telegram chat/channel/user ID |
| `NCBI_API_KEY` | NCBI API key |
| `NCBI_EMAIL` | Developer email for NCBI requests |

Worker variables:

| Variable | Default |
|---|---|
| `NCBI_TOOL` | `MedBot` |
| `DIGEST_MAX_ARTICLES` | `18` |
| `HIGH_EVIDENCE_LIMIT` | `10` |
| `OBSERVATIONAL_LIMIT` | `5` |
| `RELATED_RECORD_LIMIT` | `3` |
| `ENTREZ_LOOKBACK_DAYS` | `10` |
| `MIN_SCORE` | `20` |

## Worker Flow

Scheduled run:

1. Cron trigger fires on Sunday.
2. Worker builds three topic queries.
3. Worker calls `EGQuery` for each topic.
4. Worker selects the target Entrez databases to search.
5. Worker runs `ESearch` across those databases.
6. Worker merges and deduplicates IDs by database.
7. Worker removes records already stored in KV.
8. Worker fetches metadata using `ESummary`.
9. Worker fetches detailed records using `EFetch` when needed.
10. Worker extracts title, source, journal, date, authors, abstract, DOI, publication types, and affiliations.
11. Worker scores each record.
12. Worker selects high-evidence articles first.
13. Worker adds notable observational studies second.
14. Worker optionally adds a short related-record section from non-literature databases.
15. Worker formats one Telegram digest.
16. Worker sends the digest to Telegram.
17. Worker stores sent record IDs in KV after successful delivery.
18. Worker logs run status.

## Manual Testing Endpoint

Add a protected `fetch` endpoint for testing.

Suggested routes:

| Route | Purpose |
|---|---|
| `/health` | Returns basic Worker status |
| `/preview` | Generates digest without sending |
| `/run` | Manually triggers run |
| `/last` | Returns last stored digest |

Protection:

- Require a simple admin token secret.
- Do not expose manual trigger endpoints publicly without authentication.

## Error Handling

Expected failures:

| Failure | Handling |
|---|---|
| Entrez rate limit | Back off and retry lightly |
| Entrez temporary failure | Log error and skip run |
| Telegram send failure | Do not mark records as sent |
| Empty results | Send optional “no results” message or silently skip |
| Malformed XML | Skip affected record and continue |
| Oversized Telegram message | Split digest into multiple messages |

## MVP Scope

The first version should include:

- Cloudflare Worker scheduled every Sunday.
- Three topic queries.
- Entrez-wide discovery with `EGQuery`.
- Database-specific `ESearch`, `ESummary`, and `EFetch`.
- Scoring and filtering.
- Telegram weekly digest.
- KV deduplication.
- Secrets-based configuration.
- Manual preview route.

## Later Enhancements

Potential upgrades:

- User-configurable topics.
- Telegram inline buttons for save, reject, or prioritize.
- Feedback-based scoring.
- Separate digest sections for clinical malaria, parasite biology, and vector control.
- D1 database for record history and analytics.
- AI-generated summaries.
- Automatic `ELink` enrichment from literature to gene, protein, or taxonomy records.
- PMC full-text links when available.
- Author publication-history enrichment.
- Journal-level metadata enrichment.
- Web dashboard for saved articles.

## Open Decisions

Still to confirm:

- Preferred Sunday delivery time and timezone.
- Whether to send a “no records found” message.
- Whether non-English records should be included.
- Whether preclinical/vector biology studies should be treated separately from clinical studies.
- Whether the digest should go to a private chat, group, or Telegram channel.

## Recommended First Implementation

Build the MVP with these defaults:

| Setting | Value |
|---|---|
| Schedule | Every Sunday at 09:00 UTC |
| Topics | Malaria, Plasmodium, Anopheles |
| Search scope | All Entrez databases |
| Digest focus | PubMed, PMC, Bookshelf, plus a small related-record section |
| Lookback | 10 days |
| Max items | 18 |
| Priority | Guidelines, systematic reviews, meta-analyses, RCTs |
| Secondary | Observational and epidemiologic studies |
| Storage | Workers KV |
| Hosting | Cloudflare Worker |
| Delivery | Telegram single weekly digest |
