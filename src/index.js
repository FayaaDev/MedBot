const TELEGRAM_API_BASE = 'https://api.telegram.org';
const ENTREZ_API_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const WOS_API_BASE = 'https://api.clarivate.com/apis/wos-starter/v1';
const SENT_TTL_SECONDS = 366 * 24 * 60 * 60;
const TELEGRAM_MESSAGE_LIMIT = 3900;
const DIGEST_STORAGE_PRETTY_TTL = 366 * 24 * 60 * 60;
const DEFAULT_PRIMARY_RETMAX = 25;
const DEFAULT_SECONDARY_RETMAX = 8;
const DEFAULT_WOS_RETMAX = 10;
const WOS_FREE_PLAN_SPACING_MS = 1100;

const TOPICS = [
  {
    label: 'Malaria',
    query: '(malaria[MeSH Terms] OR malaria[Title/Abstract])',
    broadQuery: 'malaria',
    tokens: ['malaria'],
  },
  {
    label: 'Plasmodium',
    query:
      '("Plasmodium falciparum"[Title/Abstract] OR "Plasmodium vivax"[Title/Abstract] OR "Plasmodium malariae"[Title/Abstract] OR "Plasmodium ovale"[Title/Abstract] OR "Plasmodium knowlesi"[Title/Abstract])',
    broadQuery:
      '"Plasmodium falciparum" OR "Plasmodium vivax" OR "Plasmodium malariae" OR "Plasmodium ovale" OR "Plasmodium knowlesi"',
    tokens: ['plasmodium falciparum', 'plasmodium vivax', 'plasmodium malariae', 'plasmodium ovale', 'plasmodium knowlesi'],
  },
];

const PRIMARY_DATABASES = ['pubmed', 'pmc'];

const HIGH_EVIDENCE_RULES = [
  { label: 'Randomized Controlled Trial', score: 60, matches: ['randomized controlled trial'] },
  { label: 'Meta-Analysis', score: 50, matches: ['meta-analysis', 'meta analysis'] },
  { label: 'Systematic Review', score: 50, matches: ['systematic review'] },
  { label: 'Controlled Clinical Trial', score: 50, matches: ['controlled clinical trial'] },
  { label: 'Clinical Trial', score: 50, matches: ['clinical trial'] },
  { label: 'Multicenter Study', score: 50, matches: ['multicenter study', 'multi-center study'] },
];

const OBSERVATIONAL_RULES = [
  { label: 'Cohort Study', score: 20, matches: ['cohort study'] },
  { label: 'Case-Control Study', score: 15, matches: ['case-control study'] },
  { label: 'Cross-Sectional Study', score: 15, matches: ['cross-sectional study'] },
];

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      ctx.waitUntil(recordError(env, error));
      return jsonResponse(
        {
          ok: false,
          error: error.message,
        },
        500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDigest(env, { reason: 'scheduled', deliver: true }));
  },
};

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
    return handleTelegramWebhook(request, env);
  }

  if (url.pathname === '/ping') {
    return new Response('pong', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (url.pathname === '/health') {
    const lastRun = await env.MEDBOT_KV.get('run:last', 'json');
    return jsonResponse({
      ok: true,
      service: 'medbot',
      topics: TOPICS.map((topic) => topic.label),
      primaryDatabases: PRIMARY_DATABASES,
      externalSources: ['entrez', 'wos'],
      scheduleUtc: '0 6 * * *',
      config: getPublicConfigFromEnv(env),
      lastRun,
    });
  }

  if (url.pathname === '/preview') {
    ensureAuthorized(request, env);
    const result = await runDigest(env, { reason: 'preview', deliver: false });
    return jsonResponse({ ok: true, mode: 'preview', result });
  }

  if (url.pathname === '/run') {
    ensureAuthorized(request, env);
    const result = await runDigest(env, { reason: 'manual', deliver: true });
    return jsonResponse({ ok: true, mode: 'run', result });
  }

  if (url.pathname === '/last') {
    ensureAuthorized(request, env);
    const lastDigest = await env.MEDBOT_KV.get('run:last', 'json');
    if (!lastDigest?.digestKey) {
      return jsonResponse({ ok: true, digest: null });
    }

    const digest = await env.MEDBOT_KV.get(lastDigest.digestKey, 'json');
    return jsonResponse({ ok: true, digest });
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

async function handleTelegramWebhook(request, env) {
  validateTelegramWebhook(request, env);

  const update = await request.json().catch(() => null);
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();

  if (!chatId || !text) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const configuredChatId = env.TELEGRAM_CHAT_ID || '';
  if (configuredChatId && String(chatId) !== String(configuredChatId)) {
    return jsonResponse({ ok: true, ignored: true, reason: 'unauthorized_chat' });
  }

  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (command === '/ping') {
    const telegram = createTelegramClient(env);
    const response = await telegram.sendMessage(String(chatId), 'pong', {
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    if (!response.ok) {
      throw new Error(`Telegram send failed: ${response.description || 'unknown error'}`);
    }

    return jsonResponse({ ok: true, handled: '/ping' });
  }

  if (command === '/run') {
    const result = await runDigest(env, { reason: 'telegram', deliver: true });
    return jsonResponse({ ok: true, handled: '/run', result });
  }

  if (command === '/runall') {
    const result = await runDigest(env, { reason: 'telegram_runall', deliver: true, mode: 'all' });
    return jsonResponse({ ok: true, handled: '/runall', result });
  }

  return jsonResponse({ ok: true, ignored: true, command });
}

async function runDigest(env, { reason, deliver, mode = 'scored' }) {
  const config = getConfig(env, { requireDeliverySecrets: deliver });
  const startedAt = new Date().toISOString();

  try {
    const digest = await buildDigest(env, config, mode);
    const messageText = digest.hasContent || config.sendEmptyDigest ? digest.messageText : '';
    let sentMessages = 0;

    if (deliver && messageText) {
      const telegram = createTelegramClient(env);
      sentMessages = await sendTelegramDigest(telegram, config.telegramChatId, messageText);
      await markSent(env, digest.sentKeys);
    }

    const digestDate = startedAt.slice(0, 10);
    const digestKey = `digest:${digestDate}`;
    const result = {
      ok: true,
      reason,
      deliver,
      mode,
      startedAt,
      completedAt: new Date().toISOString(),
      sentMessages,
      sentRecords: deliver && messageText ? digest.sentKeys.length : 0,
      digestKey,
      hasContent: digest.hasContent,
      summary: digest.summary,
      messageText: digest.messageText,
      discovery: digest.discovery,
      selectedCounts: digest.selectedCounts,
    };

    await Promise.all([
      env.MEDBOT_KV.put('run:last', JSON.stringify(result), {
        expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
      }),
      env.MEDBOT_KV.put(digestKey, JSON.stringify(digest.storagePayload), {
        expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
      }),
    ]);

    console.log(JSON.stringify({ event: 'digest_success', reason, deliver, mode, selected: digest.selectedCounts }));
    return result;
  } catch (error) {
    await recordError(env, error);
    console.error(JSON.stringify({ event: 'digest_failure', reason, mode, error: error.message }));
    throw error;
  }
}

async function buildDigest(env, config, mode = 'scored') {
  const entrez = createEntrezClient(env, config);
  const wos = createWosClient(env, config);
  const discoveryEntries = await Promise.all(TOPICS.map((topic) => discoverTopic(entrez, wos, topic, config)));
  const discovery = Object.fromEntries(discoveryEntries.map((entry) => [entry.topic, entry.counts]));

  const primaryMatches = await collectSearchMatches(entrez, PRIMARY_DATABASES, DEFAULT_PRIMARY_RETMAX, config.lookbackDays);
  const primaryItems = await enrichPrimaryRecords(entrez, primaryMatches, config);
  const wosPrimaryItems = wos ? await collectWosPrimaryItems(wos, config) : [];
  const rankedPrimaryItems = [...primaryItems, ...wosPrimaryItems]
    .map((item) => scorePrimaryItem(item, config))
    .filter((item) => item.title)
    .sort(sortByScore);

  const selection =
    mode === 'all'
      ? await selectAllMatchingItems(env, rankedPrimaryItems, config)
      : await selectDigestItems(env, rankedPrimaryItems, config);
  const messageText = formatDigest(selection, discovery, config, mode);
  const digestDate = new Date().toISOString().slice(0, 10);

  return {
    hasContent: selection.highEvidence.length + selection.observational.length > 0,
    messageText,
    summary: selection.summary,
    discovery,
    selectedCounts: {
      highEvidence: selection.highEvidence.length,
      observational: selection.observational.length,
    },
    sentKeys: [
      ...selection.highEvidence.map((item) => sentKey(item.db, item.id)),
      ...selection.observational.map((item) => sentKey(item.db, item.id)),
    ],
    storagePayload: {
      digestDate,
      selection,
      discovery,
      messageText,
      generatedAt: new Date().toISOString(),
      config: publicConfig(config),
      mode,
    },
  };
}

async function discoverTopic(entrez, wos, topic, config) {
  const counts = {};
  const countEntries = await Promise.all([
    ...PRIMARY_DATABASES.map(async (db) => {
      const response = await entrez.json('esearch.fcgi', {
        db,
        term: buildSearchQuery(db, topic),
        retmax: 0,
      });

      return [db, Number(response?.esearchresult?.count || 0)];
    }),
    wos
      ? wos.documents({
          db: config.wosDb,
          q: buildWosSearchQuery(topic),
          limit: 1,
          page: 1,
          sortField: config.wosSort,
          publishTimeSpan: buildDateRange(config.lookbackDays),
        }).then((response) => ['wos', Number(response?.metadata?.total || 0)])
      : Promise.resolve(['wos', 0]),
  ]);

  for (const [key, value] of countEntries) {
    counts[key] = value;
  }

  return {
    topic: topic.label,
    counts,
  };
}

async function collectSearchMatches(entrez, databases, retmax, lookbackDays) {
  const merged = new Map();

  for (const db of databases) {
    for (const topic of TOPICS) {
      const response = await entrez.json('esearch.fcgi', {
        db,
        term: buildSearchQuery(db, topic),
        retmax,
        sort: 'pub date',
        reldate: lookbackDays,
        datetype: 'pdat',
      });

      const ids = response?.esearchresult?.idlist || [];
      for (const id of ids) {
        const key = `${db}:${id}`;
        const existing = merged.get(key) || { db, id, matchedTopics: new Set() };
        existing.matchedTopics.add(topic.label);
        merged.set(key, existing);
      }
    }
  }

  return Array.from(merged.values()).map((item) => ({
    db: item.db,
    id: item.id,
    matchedTopics: Array.from(item.matchedTopics),
  }));
}

async function enrichPrimaryRecords(entrez, matches) {
  const grouped = groupBy(matches, (match) => match.db);
  const items = [];

  for (const [db, dbMatches] of grouped) {
    const ids = dbMatches.map((match) => match.id);
    const summaries = await fetchSummaries(entrez, db, ids);
    const detailMap = db === 'pubmed' ? await fetchPubMedDetails(entrez, ids) : new Map();

    for (const match of dbMatches) {
      const summary = summaries.get(match.id);
      if (!summary) {
        continue;
      }

      const details = detailMap.get(match.id) || {};
      items.push(normalizePrimaryRecord(db, match, summary, details));
    }
  }

  return items;
}

async function collectWosPrimaryItems(wos, config) {
  const merged = new Map();
  const publishTimeSpan = buildDateRange(config.lookbackDays);

  for (const topic of TOPICS) {
    const response = await wos.documents({
      db: config.wosDb,
      q: buildWosSearchQuery(topic),
      limit: config.wosRetmax,
      page: 1,
      sortField: config.wosSort,
      publishTimeSpan,
    });

    for (const hit of response?.hits || []) {
      const key = String(hit?.uid || '');
      if (!key) {
        continue;
      }

      const existing = merged.get(key) || { document: hit, matchedTopics: new Set() };
      existing.matchedTopics.add(topic.label);
      if (!existing.document?.title && hit?.title) {
        existing.document = hit;
      }
      merged.set(key, existing);
    }
  }

  return Array.from(merged.values()).map(({ document, matchedTopics }) =>
    normalizeWosPrimaryRecord(document, Array.from(matchedTopics))
  );
}

async function fetchSummaries(entrez, db, ids) {
  const results = new Map();

  for (const chunk of chunkArray(ids, 20)) {
    const response = await entrez.json('esummary.fcgi', {
      db,
      id: chunk.join(','),
    });
    const summaryResult = response?.result || {};
    const uids = summaryResult.uids || [];

    for (const uid of uids) {
      results.set(String(uid), summaryResult[uid]);
    }
  }

  return results;
}

async function fetchPubMedDetails(entrez, ids) {
  const results = new Map();

  for (const chunk of chunkArray(ids, 20)) {
    const xml = await entrez.xml('efetch.fcgi', {
      db: 'pubmed',
      id: chunk.join(','),
      rettype: 'abstract',
    });

    for (const block of extractBlocks(xml, 'PubmedArticle')) {
      const pmid = firstTagValue(block, 'PMID');
      if (!pmid) {
        continue;
      }

      const abstractParts = allTagValues(block, 'AbstractText').map(cleanXmlText).filter(Boolean);
      const publicationTypes = allTagValues(block, 'PublicationType').map(cleanXmlText).filter(Boolean);
      const doi = firstMatchingValue(block, [
        /<ArticleId[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/i,
        /<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/i,
      ]);
      const authors = extractAuthorsFromPubMedXml(block);

      results.set(pmid, {
        abstract: abstractParts.join(' '),
        publicationTypes,
        doi: cleanXmlText(doi),
        authors,
      });
    }
  }

  return results;
}

function normalizePrimaryRecord(db, match, summary, details) {
  const title = cleanText(
    summary.title || summary.booktitle || summary.caption || summary.name || details.title || ''
  );
  const journal = cleanText(summary.fulljournalname || summary.source || summary.bookname || summary.publisher || db);
  const publicationTypes = uniqueStrings([
    ...(Array.isArray(summary.pubtype) ? summary.pubtype : []),
    ...(Array.isArray(details.publicationTypes) ? details.publicationTypes : []),
  ]);
  const authors = details.authors?.length ? details.authors : normalizeSummaryAuthors(summary.authors);
  const doi = extractDoi(summary) || details.doi || '';
  const abstract = cleanText(details.abstract || '');
  const sourceUrl = buildSourceUrl(db, match.id);
  const pubDate = normalizeDate(summary.pubdate || summary.sortpubdate || summary.epubdate || '');

  return {
    db,
    id: match.id,
    title,
    journal,
    publicationTypes,
    authors,
    doi,
    abstract,
    pubDate,
    sourceUrl,
    matchedTopics: match.matchedTopics,
  };
}

function normalizeWosPrimaryRecord(document, matchedTopics) {
  const authors = Array.isArray(document?.names?.authors)
    ? document.names.authors.map((author) => cleanText(author?.displayName || '')).filter(Boolean)
    : [];
  const publicationTypes = uniqueStrings([
    ...(Array.isArray(document?.types) ? document.types : []),
    ...(Array.isArray(document?.sourceTypes) ? document.sourceTypes : []),
  ]);
  const keywords = Array.isArray(document?.keywords?.authorKeywords)
    ? document.keywords.authorKeywords.map((keyword) => cleanText(keyword)).filter(Boolean)
    : [];

  return {
    db: 'wos',
    id: cleanText(document?.uid || ''),
    title: cleanText(document?.title || ''),
    journal: cleanText(document?.source?.sourceTitle || 'Web of Science'),
    publicationTypes,
    authors,
    doi: cleanText(document?.identifiers?.doi || ''),
    abstract: keywords.length ? `Keywords: ${keywords.join(', ')}` : '',
    pubDate: normalizeDate(buildWosPubDate(document?.source)),
    sourceUrl: cleanText(document?.links?.record || ''),
    matchedTopics,
    pmid: cleanText(document?.identifiers?.pmid || ''),
    timesCited: extractWosTimesCited(document?.citations),
  };
}

function scorePrimaryItem(item, config) {
  const publicationTypes = item.publicationTypes.map((value) => value.toLowerCase());
  let score = 0;
  let evidenceType = '';
  let tier = 'other';

  for (const rule of HIGH_EVIDENCE_RULES) {
    if (publicationTypes.some((value) => rule.matches.some((match) => value.includes(match)))) {
      score += rule.score;
      tier = 'high';
      evidenceType = rule.label;
      break;
    }
  }

  if (tier !== 'high') {
    for (const rule of OBSERVATIONAL_RULES) {
      if (publicationTypes.some((value) => rule.matches.some((match) => value.includes(match)))) {
        score += rule.score;
        tier = 'observational';
        evidenceType = rule.label;
        break;
      }
    }
  }

  if (item.db === 'wos') {
    score += 5;
  }

  return {
    ...item,
    score,
    evidenceType,
    tier,
    whySelected: buildWhySelected(item, { score, evidenceType, tier }),
  };
}

async function selectDigestItems(env, primaryItems, config) {
  const selectedIds = new Set();
  const articleLimit = Math.max(0, config.digestMaxArticles);
  const highEvidenceCandidates = [];
  const observationalCandidates = [];
  const overflowCandidates = [];

  for (const item of primaryItems) {
    const key = `${item.db}:${item.id}`;
    if (selectedIds.has(key)) {
      continue;
    }

    if (item.tier === 'high') {
      highEvidenceCandidates.push(item);
      continue;
    }

    if (item.tier === 'observational') {
      observationalCandidates.push(item);
      continue;
    }

    overflowCandidates.push(item);
  }

  const highEvidence = await pickUnsents(env, highEvidenceCandidates, config.highEvidenceLimit, selectedIds);
  const observational = await pickUnsents(
    env,
    observationalCandidates,
    Math.min(config.observationalLimit, Math.max(0, articleLimit - highEvidence.length)),
    selectedIds
  );
  const overflow = await pickUnsents(env, overflowCandidates, Math.max(0, articleLimit - highEvidence.length - observational.length), selectedIds);

  return {
    highEvidence,
    observational: [...observational, ...overflow],
    summary: {
      consideredPrimary: primaryItems.length,
    },
  };
}

async function pickUnsents(env, items, limit, selectedIds) {
  const picked = [];

  for (const item of items) {
    if (picked.length >= limit) {
      break;
    }

    const key = `${item.db}:${item.id}`;
    if (selectedIds.has(key)) {
      continue;
    }

    const alreadySent = await env.MEDBOT_KV.get(sentKey(item.db, item.id));
    if (alreadySent) {
      continue;
    }

    picked.push(item);
    selectedIds.add(key);
  }

  return picked;
}

async function selectAllMatchingItems(env, primaryItems, config) {
  const selectedIds = new Set();
  const candidates = primaryItems.filter((item) => item.title);
  const articles = await pickUnsents(env, candidates, config.digestMaxArticles, selectedIds);

  return {
    highEvidence: articles,
    observational: [],
    summary: {
      consideredPrimary: primaryItems.length,
    },
  };
}

function formatDigest(selection, discovery, config, mode = 'scored') {
  const lines = ['MedBot Daily Digest: Malaria, Plasmodium, Anopheles', ''];

  if (selection.highEvidence.length === 0 && selection.observational.length === 0) {
    lines.push('No high-signal records matched this week for Malaria, Plasmodium, or Anopheles.');
    return lines.join('\n');
  }

  if (mode === 'all') {
    lines.push('All Matching Articles');
    lines.push(...formatPrimarySection(selection.highEvidence, 1));
    lines.push('');
    lines.push(`Discovery window: last ${config.lookbackDays} days`);
    lines.push(`Signal snapshot: ${formatDiscoverySummary(discovery)}`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  lines.push('Analytic Studies');
  lines.push(...formatPrimarySection(selection.highEvidence, 1));
  lines.push('');
  lines.push('Observational Studies');
  lines.push(...formatPrimarySection(selection.observational, selection.highEvidence.length + 1));
  lines.push('');
  lines.push(`Discovery window: last ${config.lookbackDays} days`);
  lines.push(`Signal snapshot: ${formatDiscoverySummary(discovery)}`);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatPrimarySection(items, startIndex) {
  if (items.length === 0) {
    return ['None selected this week.'];
  }

  return items.flatMap((item, index) => {
    const rank = startIndex + index;
    const snippet = truncateText(item.abstract || item.whySelected, 280);
    const lines = [
      `${rank}. ${item.title}`,
      `Date: ${item.pubDate || 'Unknown date'}`,
      `Journal: ${item.journal || 'Unknown source'}`,
      `Topic: ${item.matchedTopics.join(', ')}`,
    ];

    if (item.evidenceType) {
      lines.splice(3, 0, `Type: ${item.evidenceType}`);
    }

    if (snippet) {
      lines.push(`Snippet: ${snippet}`);
    } else {
      lines.push('Snippet: None available.');
    }

    lines.push(`Record: ${item.sourceUrl}`);

    lines.push('');
    return lines;
  });
}

async function sendTelegramDigest(telegram, chatId, messageText) {
  const chunks = splitMessage(messageText, TELEGRAM_MESSAGE_LIMIT);

  for (const chunk of chunks) {
    const response = await telegram.sendMessage(chatId, chunk, {
      disable_web_page_preview: true,
    });

    if (!response.ok) {
      throw new Error(`Telegram send failed: ${response.description || 'unknown error'}`);
    }
  }

  return chunks.length;
}

function createTelegramClient(env) {
  const token = requiredSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN');

  return {
    async sendMessage(chatId, text, extra = {}) {
      return postJson(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        ...extra,
      });
    },
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  try {
    return await response.json();
  } catch {
    return {
      ok: false,
      description: `Invalid JSON response with status ${response.status}`,
    };
  }
}

function createEntrezClient(env, config) {
  const email = requiredSecret(env.NCBI_EMAIL, 'NCBI_EMAIL');
  const apiKey = env.NCBI_API_KEY || '';
  const minSpacingMs = apiKey ? 120 : 350;
  let lastRequestAt = 0;

  async function request(endpoint, params, retmode) {
    const now = Date.now();
    const waitMs = Math.max(0, minSpacingMs - (now - lastRequestAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const searchParams = new URLSearchParams({
      ...stringifyParams(params),
      tool: config.ncbiTool,
      email,
      retmode,
    });

    if (apiKey) {
      searchParams.set('api_key', apiKey);
    }

    const response = await fetchWithRetry(`${ENTREZ_API_BASE}/${endpoint}?${searchParams.toString()}`);
    lastRequestAt = Date.now();

    if (retmode === 'json') {
      return response.json();
    }

    return response.text();
  }

  return {
    json(endpoint, params) {
      return request(endpoint, params, 'json');
    },
    xml(endpoint, params) {
      return request(endpoint, params, 'xml');
    },
  };
}

function createWosClient(env, config) {
  const apiKey = env.WOS_STARTER_API_KEY || '';
  if (!config.wosEnabled || !apiKey) {
    return null;
  }

  let lastRequestAt = 0;

  async function request(path, params) {
    const now = Date.now();
    const waitMs = Math.max(0, WOS_FREE_PLAN_SPACING_MS - (now - lastRequestAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const searchParams = new URLSearchParams(stringifyParams(params));
    const response = await fetchWithRetry(`${WOS_API_BASE}${path}?${searchParams.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MedBot/1.0 (+Web of Science Starter digest bot)',
        'X-ApiKey': apiKey,
      },
      errorLabel: 'WoS request',
    });
    lastRequestAt = Date.now();

    return response.json();
  }

  return {
    documents(params) {
      return request('/documents', params);
    },
  };
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || 3;
  const headers = options.headers || {
    Accept: 'application/json, text/xml;q=0.9, */*;q=0.8',
    'User-Agent': 'MedBot/1.0 (+NCBI E-utilities daily digest bot)',
  };
  const errorLabel = options.errorLabel || 'Entrez request';
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`${errorLabel} failed with status ${response.status}`);
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (!response.ok) {
        throw new Error(`${errorLabel} failed with status ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error(`${errorLabel} failed`);
}

function getConfig(env, options = {}) {
  const requireDeliverySecrets = options.requireDeliverySecrets !== false;

  return {
    ncbiTool: env.NCBI_TOOL || 'MedBot',
    telegramChatId: requireDeliverySecrets ? requiredSecret(env.TELEGRAM_CHAT_ID, 'TELEGRAM_CHAT_ID') : env.TELEGRAM_CHAT_ID || '',
    digestMaxArticles: parseNumber(env.DIGEST_MAX_ARTICLES, 18),
    highEvidenceLimit: parseNumber(env.HIGH_EVIDENCE_LIMIT, 10),
    observationalLimit: parseNumber(env.OBSERVATIONAL_LIMIT, 5),
    lookbackDays: parseNumber(env.ENTREZ_LOOKBACK_DAYS, 2),
    sendEmptyDigest: parseBoolean(env.SEND_EMPTY_DIGEST, false),
    wosEnabled: parseBoolean(env.WOS_ENABLED, true),
    wosDb: cleanText(env.WOS_DB || 'WOS') || 'WOS',
    wosRetmax: parseNumber(env.WOS_RETMAX, DEFAULT_WOS_RETMAX),
    wosSort: cleanText(env.WOS_SORT || 'LD+D') || 'LD+D',
  };
}

function getPublicConfigFromEnv(env) {
  return publicConfig(getConfig(env, { requireDeliverySecrets: false }));
}

function publicConfig(config) {
  return {
    ncbiTool: config.ncbiTool,
    digestMaxArticles: config.digestMaxArticles,
    highEvidenceLimit: config.highEvidenceLimit,
    observationalLimit: config.observationalLimit,
    lookbackDays: config.lookbackDays,
    sendEmptyDigest: config.sendEmptyDigest,
    wosEnabled: config.wosEnabled,
    wosDb: config.wosDb,
    wosRetmax: config.wosRetmax,
    wosSort: config.wosSort,
  };
}

function ensureAuthorized(request, env) {
  const adminToken = requiredSecret(env.ADMIN_TOKEN, 'ADMIN_TOKEN');
  const authHeader = request.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const headerToken = request.headers.get('x-admin-token') || '';
  const provided = bearerToken || headerToken;

  if (!provided || !safeEqual(provided, adminToken)) {
    throw new Response('Unauthorized', { status: 401 });
  }
}

function validateTelegramWebhook(request, env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!secret) {
    return;
  }

  const provided = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!provided || !safeEqual(provided, secret)) {
    throw new Response('Unauthorized', { status: 401 });
  }
}

async function recordError(env, error) {
  const payload = {
    at: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
  };

  try {
    await env.MEDBOT_KV.put('error:last', JSON.stringify(payload), {
      expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
    });
  } catch (kvError) {
    console.error(JSON.stringify({ event: 'error_record_failed', error: kvError.message }));
  }
}

async function markSent(env, keys) {
  await Promise.all(
    uniqueStrings(keys).map((key) =>
      env.MEDBOT_KV.put(key, new Date().toISOString(), {
        expirationTtl: SENT_TTL_SECONDS,
      })
    )
  );
}

function sentKey(db, id) {
  return `sent:${db}:${id}`;
}

function buildSourceUrl(db, id) {
  if (db === 'pubmed') {
    return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
  }
  if (db === 'pmc') {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${id.startsWith('PMC') ? id : `PMC${id}`}/`;
  }
  if (db === 'books') {
    return `https://www.ncbi.nlm.nih.gov/books/${id}/`;
  }

  return `https://www.ncbi.nlm.nih.gov/${db}/${id}`;
}

function extractDoi(summary) {
  const articleIds = Array.isArray(summary.articleids) ? summary.articleids : [];
  for (const articleId of articleIds) {
    if (String(articleId.idtype || '').toLowerCase() === 'doi') {
      return cleanText(articleId.value || '');
    }
  }

  return '';
}

function normalizeSummaryAuthors(authors) {
  if (!Array.isArray(authors)) {
    return [];
  }

  return authors.map((author) => cleanText(author?.name || '')).filter(Boolean);
}

function extractAuthorsFromPubMedXml(block) {
  return extractBlocks(block, 'Author')
    .map((authorBlock) => {
      const collectiveName = firstTagValue(authorBlock, 'CollectiveName');
      if (collectiveName) {
        return cleanXmlText(collectiveName);
      }

      const lastName = cleanXmlText(firstTagValue(authorBlock, 'LastName'));
      const foreName = cleanXmlText(firstTagValue(authorBlock, 'ForeName'));
      return cleanText(`${foreName} ${lastName}`);
    })
    .filter(Boolean);
}

function buildWhySelected(item, { evidenceType, tier }) {
  const reasons = [];
  if (tier === 'high') {
    reasons.push(`${evidenceType.toLowerCase()} signal`);
  }
  if (tier === 'observational') {
    reasons.push('observational evidence');
  }
  if (item.matchedTopics.length > 1) {
    reasons.push('multiple target topics matched');
  }
  if (item.abstract) {
    reasons.push('abstract available');
  }
  if (item.doi) {
    reasons.push('has DOI');
  }
  if (!reasons.length) {
    reasons.push('topic-relevant recent record');
  }

  return reasons.join(', ');
}

function formatDiscoverySummary(discovery) {
  return TOPICS.map((topic) => {
    const counts = discovery[topic.label] || {};
    const parts = [...PRIMARY_DATABASES, 'wos'].map((db) => `${db}:${counts[db] || 0}`);
    return `${topic.label}(${parts.join(', ')})`;
  }).join(' | ');
}

function formatAuthors(authors) {
  if (!authors.length) {
    return 'Unknown';
  }
  if (authors.length === 1) {
    return authors[0];
  }
  return `${authors[0]} et al.`;
}

function buildSearchQuery(db, topic) {
  return PRIMARY_DATABASES.includes(db) ? topic.query : topic.broadQuery;
}

function buildWosSearchQuery(topic) {
  return `TS=(${topic.broadQuery})`;
}

function splitMessage(text, limit) {
  if (text.length <= limit) {
    return [text];
  }

  const paragraphs = text.split('\n\n');
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > limit) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function extractBlocks(xml, tagName) {
  const regex = new RegExp(`<${tagName}(?: [^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const blocks = [];
  let match;

  while ((match = regex.exec(xml))) {
    blocks.push(match[0]);
  }

  return blocks;
}

function firstTagValue(xml, tagName) {
  const match = new RegExp(`<${tagName}(?: [^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(xml);
  return match ? match[1] : '';
}

function allTagValues(xml, tagName) {
  const regex = new RegExp(`<${tagName}(?: [^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const values = [];
  let match;

  while ((match = regex.exec(xml))) {
    values.push(match[1]);
  }

  return values;
}

function firstMatchingValue(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1];
    }
  }

  return '';
}

function cleanXmlText(value) {
  return cleanText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function truncateText(value, length) {
  if (!value || value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1).trim()}...`;
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) {
    return '';
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }

  return date.toISOString().slice(0, 10);
}

function buildDateRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(0, days) * 24 * 60 * 60 * 1000);
  return `${start.toISOString().slice(0, 10)}+${end.toISOString().slice(0, 10)}`;
}

function buildWosPubDate(source) {
  const year = String(source?.publishYear || '').trim();
  if (!year) {
    return '';
  }

  const month = normalizeMonth(source?.publishMonth);
  if (!month) {
    return year;
  }

  return `${year}-${month}-01`;
}

function normalizeMonth(value) {
  const months = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12',
  };
  const text = cleanText(value).slice(0, 3).toUpperCase();
  return months[text] || '';
}

function extractWosTimesCited(citations) {
  if (!Array.isArray(citations)) {
    return 0;
  }

  for (const citation of citations) {
    if (citation?.db === 'WOS') {
      return Number(citation.count || 0);
    }
  }

  return 0;
}

function isRecentWithinDays(dateText, days) {
  if (!dateText) {
    return false;
  }

  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
}

function groupBy(items, selector) {
  const grouped = new Map();
  for (const item of items) {
    const key = selector(item);
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  }
  return grouped;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function stringifyParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => [key, String(value)])
  );
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

function requiredSecret(value, name) {
  if (!value) {
    throw new Error(`Missing required secret or variable: ${name}`);
  }
  return value;
}

function safeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortByScore(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return String(right.pubDate || '').localeCompare(String(left.pubDate || ''));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
