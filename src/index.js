const TELEGRAM_API_BASE = 'https://api.telegram.org';
const ENTREZ_API_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const WOS_API_BASE = 'https://api.clarivate.com/apis/wos-starter/v1';
const SENT_TTL_SECONDS = 366 * 24 * 60 * 60;
const TELEGRAM_MESSAGE_LIMIT = 3900;
const DIGEST_STORAGE_PRETTY_TTL = 366 * 24 * 60 * 60;
const DEFAULT_PRIMARY_RETMAX = 25;
const DEFAULT_WOS_RETMAX = 10;
const WOS_FREE_PLAN_SPACING_MS = 1100;
const MAX_USER_TOPICS = 5;
const MAX_KEYWORDS_LENGTH = 500;
const USER_PREFIX = 'user:';
const USER_DIGEST_PREFIX = 'digest:';
const USER_LAST_PREFIX = 'last:';
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
    ctx.waitUntil(handleScheduled(env));
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
    return jsonResponse({
      ok: true,
      service: 'medbot',
      primaryDatabases: PRIMARY_DATABASES,
      externalSources: ['entrez', 'wos'],
      scheduleUtc: '0 6 * * *',
      subscriptionModel: 'per-user',
      commands: ['/start', '/run', '/changekeyword', '/stop'],
      config: getPublicConfigFromEnv(env),
      lastRun: await env.MEDBOT_KV.get('run:last', 'json'),
    });
  }

  if (url.pathname === '/preview' && request.method === 'POST') {
    ensureAuthorized(request, env);
    const payload = await readJsonBody(request);
    const { subscription, topics, keywordsRaw } = await resolveDigestTarget(env, payload, { requireChatId: false });
    const result = await runDigest(env, {
      reason: 'preview',
      deliver: false,
      subscription,
      topics,
      keywordsRaw,
      persist: false,
    });
    return jsonResponse({ ok: true, mode: 'preview', result });
  }

  if (url.pathname === '/run' && request.method === 'POST') {
    ensureAuthorized(request, env);
    const payload = await readJsonBody(request);
    const { subscription } = await resolveDigestTarget(env, payload, { requireChatId: true });
    const result = await runDigest(env, {
      reason: 'manual',
      deliver: true,
      subscription,
      persist: true,
      storeGlobalLast: true,
    });
    return jsonResponse({ ok: true, mode: 'run', result });
  }

  if (url.pathname === '/last') {
    ensureAuthorized(request, env);
    const chatId = cleanText(url.searchParams.get('chatId') || '');
    if (!chatId) {
      const lastRun = await env.MEDBOT_KV.get('run:last', 'json');
      return jsonResponse({ ok: true, digest: lastRun });
    }

    const lastDigest = await env.MEDBOT_KV.get(lastDigestPointerKey(chatId), 'json');
    if (!lastDigest?.digestKey) {
      return jsonResponse({ ok: true, digest: null });
    }

    const digest = await env.MEDBOT_KV.get(lastDigest.digestKey, 'json');
    return jsonResponse({ ok: true, digest });
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

async function handleScheduled(env) {
  const subscriptions = await listSubscriptions(env);
  const activeSubscriptions = subscriptions.filter((subscription) => subscription.active && subscription.topics.length > 0);
  const digestDate = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const subscription of activeSubscriptions) {
    if (subscription.lastSentDate === digestDate) {
      continue;
    }

    try {
      const result = await runDigest(env, {
        reason: 'scheduled',
        deliver: true,
        subscription,
        persist: true,
      });
      await saveSubscription(env, {
        ...subscription,
        lastSentDate: digestDate,
        updatedAt: new Date().toISOString(),
      });
      results.push({ chatId: subscription.chatId, ok: true, sentMessages: result.sentMessages });
    } catch (error) {
      await recordError(env, error);
      console.error(JSON.stringify({ event: 'scheduled_user_failure', chatId: subscription.chatId, error: error.message }));
      results.push({ chatId: subscription.chatId, ok: false, error: error.message });
    }
  }

  const summary = {
    ok: true,
    reason: 'scheduled',
    completedAt: new Date().toISOString(),
    processedUsers: results.length,
    deliveredUsers: results.filter((result) => result.ok).length,
    failedUsers: results.filter((result) => !result.ok).length,
    results,
  };

  await env.MEDBOT_KV.put('run:last', JSON.stringify(summary), {
    expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
  });

  return summary;
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

  const telegram = createTelegramClient(env);
  const subscription = (await getSubscription(env, chatId)) || createSubscription(chatId);
  const command = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : '';
  const args = command ? text.slice(command.length).trim() : '';

  if (command === '/start') {
    const nextSubscription = subscription.topics.length
      ? {
          ...subscription,
          active: true,
          state: 'ready',
          updatedAt: new Date().toISOString(),
        }
      : {
          ...subscription,
          active: true,
          state: 'awaiting_keywords',
          updatedAt: new Date().toISOString(),
        };
    await saveSubscription(env, nextSubscription);

    const messageText = subscription.topics.length
      ? [
          'Welcome to MedBot.',
          `Current keywords: ${formatTopicList(subscription.topics)}.`,
          'Use /changekeyword to update them.',
          'Reports are sent daily at 09:00 GMT+3.',
        ].join('\n')
      : [
          'Welcome to MedBot.',
          'Send your keywords as comma-separated topics or as one free-text research query.',
          'Example: diabetes, hypertension, GLP-1',
          'Reports are sent daily at 09:00 GMT+3.',
        ].join('\n');

    await sendTelegramText(telegram, chatId, messageText, message?.message_id);
    return jsonResponse({ ok: true, handled: '/start' });
  }

  if (command === '/changekeyword') {
    if (!args) {
      await saveSubscription(env, {
        ...subscription,
        active: true,
        state: 'awaiting_keywords',
        updatedAt: new Date().toISOString(),
      });
      await sendTelegramText(
        telegram,
        chatId,
        'Send your new keywords as comma-separated topics or one free-text research query.',
        message?.message_id
      );
      return jsonResponse({ ok: true, handled: '/changekeyword' });
    }

    let updatedSubscription;
    try {
      updatedSubscription = await updateSubscriptionKeywords(env, subscription, args);
    } catch (error) {
      await sendTelegramText(telegram, chatId, error.message, message?.message_id);
      return jsonResponse({ ok: true, handled: '/changekeyword', error: error.message });
    }
    await sendTelegramText(
      telegram,
      chatId,
      [`Keywords saved.`, `Current keywords: ${formatTopicList(updatedSubscription.topics)}.`, 'Reports are sent daily at 09:00 GMT+3.'].join('\n'),
      message?.message_id
    );
    return jsonResponse({ ok: true, handled: '/changekeyword' });
  }

  if (command === '/stop') {
    await saveSubscription(env, {
      ...subscription,
      active: false,
      state: 'ready',
      updatedAt: new Date().toISOString(),
    });
    await sendTelegramText(telegram, chatId, 'Your subscription is paused. Use /start when you want reports again.', message?.message_id);
    return jsonResponse({ ok: true, handled: '/stop' });
  }

  if (command === '/run') {
    if (!subscription.topics.length) {
      await sendTelegramText(
        telegram,
        chatId,
        'No keywords are saved yet. Use /start or /changekeyword first.',
        message?.message_id
      );
      return jsonResponse({ ok: true, handled: '/run', error: 'missing_keywords' });
    }

    if (!subscription.active) {
      await sendTelegramText(
        telegram,
        chatId,
        'Your subscription is paused. Use /start first, then run the report again.',
        message?.message_id
      );
      return jsonResponse({ ok: true, handled: '/run', error: 'subscription_inactive' });
    }

    await sendTelegramText(telegram, chatId, 'Generating report now...', message?.message_id);
    const result = await runDigest(env, {
      reason: 'telegram_run',
      deliver: true,
      subscription,
      persist: true,
    });
    return jsonResponse({ ok: true, handled: '/run', result });
  }

  if (command) {
    await sendTelegramText(telegram, chatId, buildHelpMessage(), message?.message_id);
    return jsonResponse({ ok: true, ignored: true, command });
  }

  if (subscription.state === 'awaiting_keywords') {
    let updatedSubscription;
    try {
      updatedSubscription = await updateSubscriptionKeywords(env, subscription, text);
    } catch (error) {
      await sendTelegramText(telegram, chatId, error.message, message?.message_id);
      return jsonResponse({ ok: true, handled: 'keywords_reply', error: error.message });
    }
    await sendTelegramText(
      telegram,
      chatId,
      [`Keywords saved.`, `Current keywords: ${formatTopicList(updatedSubscription.topics)}.`, 'Reports are sent daily at 09:00 GMT+3.'].join('\n'),
      message?.message_id
    );
    return jsonResponse({ ok: true, handled: 'keywords_reply' });
  }

  await sendTelegramText(telegram, chatId, buildHelpMessage(), message?.message_id);
  return jsonResponse({ ok: true, ignored: true });
}

async function runDigest(
  env,
  { reason, deliver, subscription = null, topics = null, keywordsRaw = '', mode = 'scored', persist = true, storeGlobalLast = false }
) {
  const config = getConfig(env);
  const activeTopics = Array.isArray(topics) && topics.length ? topics : subscription?.topics || [];
  const sentScope = cleanText(subscription?.chatId || '') || `preview:${truncateText(keywordsRaw || formatTopicList(activeTopics), 40)}`;
  if (!activeTopics.length) {
    throw new Error('No keywords configured for this request');
  }

  const startedAt = new Date().toISOString();

  try {
    const digest = await buildDigest(env, config, activeTopics, sentScope, mode);
    const messageText = digest.hasContent || config.sendEmptyDigest ? digest.messageText : '';
    let sentMessages = 0;

    if (deliver) {
      const chatId = cleanText(subscription?.chatId || '');
      if (!chatId) {
        throw new Error('Missing chatId for delivery');
      }

      if (messageText) {
        const telegram = createTelegramClient(env);
        sentMessages = await sendTelegramDigest(telegram, chatId, messageText, buildCommandReplyMarkup());
        await markSent(env, chatId, digest.sentKeys);
      }
    }

    const digestDate = startedAt.slice(0, 10);
    const chatId = cleanText(subscription?.chatId || '');
    const digestKey = chatId ? userDigestKey(chatId, digestDate) : `${USER_DIGEST_PREFIX}preview:${digestDate}`;
    const result = {
      ok: true,
      reason,
      deliver,
      mode,
      startedAt,
      completedAt: new Date().toISOString(),
      chatId,
      sentMessages,
      sentRecords: deliver && messageText ? digest.sentKeys.length : 0,
      digestKey,
      hasContent: digest.hasContent,
      summary: digest.summary,
      keywords: keywordsRaw || subscription?.keywordsRaw || formatTopicList(activeTopics),
      messageText: digest.messageText,
      discovery: digest.discovery,
      selectedCounts: digest.selectedCounts,
    };

    const writes = [];

    if (persist && chatId) {
      writes.push(
        env.MEDBOT_KV.put(lastDigestPointerKey(chatId), JSON.stringify(result), {
          expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
        }),
        env.MEDBOT_KV.put(
          digestKey,
          JSON.stringify({
            ...digest.storagePayload,
            chatId,
            keywords: result.keywords,
            subscription: publicSubscription(subscription),
          }),
          {
            expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
          }
        )
      );
    }

    if (persist && storeGlobalLast) {
      writes.push(
        env.MEDBOT_KV.put('run:last', JSON.stringify(result), {
          expirationTtl: DIGEST_STORAGE_PRETTY_TTL,
        })
      );
    }

    if (writes.length) {
      await Promise.all(writes);
    }

    console.log(JSON.stringify({ event: 'digest_success', reason, deliver, mode, chatId, selected: digest.selectedCounts }));
    return result;
  } catch (error) {
    await recordError(env, error);
    console.error(JSON.stringify({ event: 'digest_failure', reason, mode, chatId: subscription?.chatId || '', error: error.message }));
    throw error;
  }
}

async function buildDigest(env, config, topics, sentScope, mode = 'scored') {
  const entrez = createEntrezClient(env, config);
  const wos = createWosClient(env, config);
  const discoveryEntries = await Promise.all(topics.map((topic) => discoverTopic(entrez, wos, topic, config)));
  const discovery = Object.fromEntries(discoveryEntries.map((entry) => [entry.topic, entry.counts]));

  const primaryMatches = await collectSearchMatches(entrez, PRIMARY_DATABASES, DEFAULT_PRIMARY_RETMAX, config.lookbackDays, topics);
  const primaryItems = await enrichPrimaryRecords(entrez, primaryMatches, config);
  const wosPrimaryItems = wos ? await collectWosPrimaryItems(wos, config, topics) : [];
  const rankedPrimaryItems = [...primaryItems, ...wosPrimaryItems]
    .map((item) => scorePrimaryItem(item, config))
    .filter((item) => item.title)
    .sort(sortByScore);

  const selection =
    mode === 'all'
      ? await selectAllMatchingItems(env, rankedPrimaryItems, config, sentScope)
      : await selectDigestItems(env, rankedPrimaryItems, config, sentScope);
  const messageText = formatDigest(selection, discovery, config, topics, mode);
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
      topics,
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
      ? wos
          .documents({
            db: config.wosDb,
            q: buildWosSearchQuery(topic),
            limit: 1,
            page: 1,
            sortField: config.wosSort,
            publishTimeSpan: buildDateRange(config.lookbackDays),
          })
          .then((response) => ['wos', Number(response?.metadata?.total || 0)])
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

async function collectSearchMatches(entrez, databases, retmax, lookbackDays, topics) {
  const merged = new Map();

  for (const db of databases) {
    for (const topic of topics) {
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

async function collectWosPrimaryItems(wos, config, topics) {
  const merged = new Map();
  const publishTimeSpan = buildDateRange(config.lookbackDays);

  for (const topic of topics) {
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

async function selectDigestItems(env, primaryItems, config, chatId) {
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

  const highEvidence = await pickUnsents(env, chatId, highEvidenceCandidates, config.highEvidenceLimit, selectedIds);
  const observational = await pickUnsents(
    env,
    chatId,
    observationalCandidates,
    Math.min(config.observationalLimit, Math.max(0, articleLimit - highEvidence.length)),
    selectedIds
  );
  const overflow = await pickUnsents(
    env,
    chatId,
    overflowCandidates,
    Math.max(0, articleLimit - highEvidence.length - observational.length),
    selectedIds
  );

  return {
    highEvidence,
    observational: [...observational, ...overflow],
    summary: {
      consideredPrimary: primaryItems.length,
    },
  };
}

async function pickUnsents(env, chatId, items, limit, selectedIds) {
  const picked = [];

  for (const item of items) {
    if (picked.length >= limit) {
      break;
    }

    const key = `${item.db}:${item.id}`;
    if (selectedIds.has(key)) {
      continue;
    }

    const alreadySent = await env.MEDBOT_KV.get(sentKeyForChat(chatId, item.db, item.id));
    if (alreadySent) {
      continue;
    }

    picked.push(item);
    selectedIds.add(key);
  }

  return picked;
}

async function selectAllMatchingItems(env, primaryItems, config, chatId) {
  const selectedIds = new Set();
  const candidates = primaryItems.filter((item) => item.title);
  const articles = await pickUnsents(env, chatId, candidates, config.digestMaxArticles, selectedIds);

  return {
    highEvidence: articles,
    observational: [],
    summary: {
      consideredPrimary: primaryItems.length,
    },
  };
}

function formatDigest(selection, discovery, config, topics, mode = 'scored') {
  const lines = ['Daily Research Digest', `Keywords: ${formatTopicList(topics)}`, ''];

  if (selection.highEvidence.length === 0 && selection.observational.length === 0) {
    lines.push(`No high-signal records matched your keywords in the last ${config.lookbackDays} days.`);
    return lines.join('\n');
  }

  if (mode === 'all') {
    lines.push('All Matching Articles');
    lines.push(...formatPrimarySection(selection.highEvidence, 1));
    lines.push('');
    lines.push(`Discovery window: last ${config.lookbackDays} days`);
    lines.push(`Signal snapshot: ${formatDiscoverySummary(discovery, topics)}`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  lines.push('Analytic Studies');
  lines.push(...formatPrimarySection(selection.highEvidence, 1));
  lines.push('');
  lines.push('Observational Studies');
  lines.push(...formatPrimarySection(selection.observational, selection.highEvidence.length + 1));
  lines.push('');
  lines.push(`Discovery window: last ${config.lookbackDays} days`);
  lines.push(`Signal snapshot: ${formatDiscoverySummary(discovery, topics)}`);

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

async function sendTelegramDigest(telegram, chatId, messageText, replyMarkup = null) {
  const chunks = splitMessage(messageText, TELEGRAM_MESSAGE_LIMIT);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const response = await telegram.sendMessage(chatId, chunk, {
      disable_web_page_preview: true,
      ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

    if (!response.ok) {
      throw new Error(`Telegram send failed: ${response.description || 'unknown error'}`);
    }
  }

  return chunks.length;
}

async function sendTelegramText(telegram, chatId, text, replyToMessageId) {
  const response = await telegram.sendMessage(String(chatId), text, {
    ...(replyToMessageId
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
          },
        }
      : {}),
    reply_markup: buildCommandReplyMarkup(),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.description || 'unknown error'}`);
  }

  return response;
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

function getConfig(env) {
  return {
    ncbiTool: env.NCBI_TOOL || 'MedBot',
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
  return publicConfig(getConfig(env));
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

async function markSent(env, chatId, keys) {
  await Promise.all(
    uniqueStrings(keys).map((key) =>
      env.MEDBOT_KV.put(sentKeyForChat(chatId, ...splitSentKey(key)), new Date().toISOString(), {
        expirationTtl: SENT_TTL_SECONDS,
      })
    )
  );
}

function sentKey(db, id) {
  return `${db}:${id}`;
}

function sentKeyForChat(chatId, db, id) {
  return `sent:${chatId}:${db}:${id}`;
}

function splitSentKey(key) {
  const [db, ...rest] = String(key).split(':');
  return [db, rest.join(':')];
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

function formatDiscoverySummary(discovery, topics) {
  return topics
    .map((topic) => {
      const counts = discovery[topic.label] || {};
      const parts = [...PRIMARY_DATABASES, 'wos'].map((db) => `${db}:${counts[db] || 0}`);
      return `${topic.label}(${parts.join(', ')})`;
    })
    .join(' | ');
}

function buildSearchQuery(db, topic) {
  return PRIMARY_DATABASES.includes(db) ? topic.query : topic.broadQuery;
}

function buildWosSearchQuery(topic) {
  return `TS=(${topic.broadQuery})`;
}

function buildTopicsFromKeywords(rawKeywords) {
  const cleaned = cleanText(rawKeywords);
  if (!cleaned) {
    throw new Error('Keywords are required');
  }

  if (cleaned.length > MAX_KEYWORDS_LENGTH) {
    throw new Error(`Keywords are too long. Keep them under ${MAX_KEYWORDS_LENGTH} characters.`);
  }

  if (cleaned.includes(',')) {
    const parts = uniqueStrings(cleaned.split(',').map((part) => cleanText(part)));
    if (!parts.length) {
      throw new Error('Provide at least one keyword');
    }
    if (parts.length > MAX_USER_TOPICS) {
      throw new Error(`Use up to ${MAX_USER_TOPICS} comma-separated keywords.`);
    }

    return parts.map((part) => {
      const fieldTerm = formatFieldTerm(part);
      const broadQuery = formatBroadTopicTerm(part);
      return {
        label: part,
        query: `(${fieldTerm}[MeSH Terms] OR ${fieldTerm}[Title/Abstract])`,
        broadQuery,
      };
    });
  }

  return [
    {
      label: truncateText(cleaned, 60),
      query: cleaned,
      broadQuery: cleaned,
    },
  ];
}

function formatFieldTerm(value) {
  const cleaned = cleanText(value).replace(/"/g, '');
  if (!cleaned) {
    return '';
  }
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function formatBroadTopicTerm(value) {
  const cleaned = cleanText(value).replace(/[()]/g, ' ');
  if (!cleaned) {
    return '';
  }
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function formatTopicList(topics) {
  return topics.map((topic) => cleanText(topic.label)).filter(Boolean).join(', ');
}

function buildHelpMessage() {
  return [
    'Use one of these commands:',
    '/start',
    '/run',
    '/changekeyword',
    '/stop',
  ].join('\n');
}

function buildCommandReplyMarkup() {
  return {
    keyboard: [[{ text: '/start' }, { text: '/run' }], [{ text: '/changekeyword' }, { text: '/stop' }]],
    is_persistent: true,
    resize_keyboard: true,
  };
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

function userKey(chatId) {
  return `${USER_PREFIX}${chatId}`;
}

function userDigestKey(chatId, digestDate) {
  return `${USER_DIGEST_PREFIX}${chatId}:${digestDate}`;
}

function lastDigestPointerKey(chatId) {
  return `${USER_LAST_PREFIX}${chatId}`;
}

function createSubscription(chatId) {
  const now = new Date().toISOString();
  return {
    chatId: String(chatId),
    active: true,
    keywordsRaw: '',
    topics: [],
    state: 'awaiting_keywords',
    createdAt: now,
    updatedAt: now,
    lastSentDate: '',
  };
}

function normalizeSubscription(subscription, chatId) {
  const base = createSubscription(chatId);
  return {
    ...base,
    ...subscription,
    chatId: String(subscription?.chatId || chatId),
    active: Boolean(subscription?.active),
    keywordsRaw: cleanText(subscription?.keywordsRaw || ''),
    topics: Array.isArray(subscription?.topics)
      ? subscription.topics
          .map((topic) => ({
            label: cleanText(topic?.label || ''),
            query: cleanText(topic?.query || ''),
            broadQuery: cleanText(topic?.broadQuery || ''),
          }))
          .filter((topic) => topic.label && topic.query && topic.broadQuery)
      : [],
    state: cleanText(subscription?.state || base.state) || base.state,
    createdAt: cleanText(subscription?.createdAt || base.createdAt) || base.createdAt,
    updatedAt: cleanText(subscription?.updatedAt || base.updatedAt) || base.updatedAt,
    lastSentDate: cleanText(subscription?.lastSentDate || ''),
  };
}

function publicSubscription(subscription) {
  if (!subscription) {
    return null;
  }

  return {
    chatId: cleanText(subscription.chatId || ''),
    active: Boolean(subscription.active),
    keywordsRaw: cleanText(subscription.keywordsRaw || ''),
    topics: Array.isArray(subscription.topics) ? subscription.topics : [],
    state: cleanText(subscription.state || ''),
    createdAt: cleanText(subscription.createdAt || ''),
    updatedAt: cleanText(subscription.updatedAt || ''),
    lastSentDate: cleanText(subscription.lastSentDate || ''),
  };
}

async function getSubscription(env, chatId) {
  const key = userKey(chatId);
  const subscription = await env.MEDBOT_KV.get(key, 'json');
  if (!subscription) {
    return null;
  }
  return normalizeSubscription(subscription, chatId);
}

async function saveSubscription(env, subscription) {
  const normalized = normalizeSubscription(subscription, subscription.chatId);
  await env.MEDBOT_KV.put(userKey(normalized.chatId), JSON.stringify(normalized));
  return normalized;
}

async function updateSubscriptionKeywords(env, subscription, rawKeywords) {
  const topics = buildTopicsFromKeywords(rawKeywords);
  return saveSubscription(env, {
    ...subscription,
    active: true,
    keywordsRaw: cleanText(rawKeywords),
    topics,
    state: 'ready',
    updatedAt: new Date().toISOString(),
  });
}

async function listSubscriptions(env) {
  const subscriptions = [];
  let cursor;

  while (true) {
    const listed = await env.MEDBOT_KV.list({ prefix: USER_PREFIX, cursor });
    for (const key of listed.keys || []) {
      const chatId = key.name.slice(USER_PREFIX.length);
      const subscription = await getSubscription(env, chatId);
      if (subscription) {
        subscriptions.push(subscription);
      }
    }

    if (!listed.list_complete) {
      cursor = listed.cursor;
      continue;
    }

    return subscriptions;
  }
}

async function resolveDigestTarget(env, payload, options = {}) {
  const requireChatId = options.requireChatId === true;
  const chatId = cleanText(payload?.chatId || '');

  if (chatId) {
    const subscription = await getSubscription(env, chatId);
    if (!subscription) {
      throw new Response('Subscription not found', { status: 404 });
    }
    if (!subscription.topics.length) {
      throw new Response('Subscription has no keywords yet', { status: 400 });
    }
    return { subscription, topics: subscription.topics, keywordsRaw: subscription.keywordsRaw };
  }

  if (requireChatId) {
    throw new Response('chatId is required', { status: 400 });
  }

  const keywordsRaw = cleanText(payload?.keywords || '');
  if (!keywordsRaw) {
    throw new Response('Provide either chatId or keywords', { status: 400 });
  }

  return {
    subscription: null,
    topics: buildTopicsFromKeywords(keywordsRaw),
    keywordsRaw,
  };
}

async function readJsonBody(request) {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    throw new Response('Invalid JSON body', { status: 400 });
  }
  return payload;
}
