import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

function createKv(entries = {}) {
  const values = new Map(Object.entries(entries));

  return {
    async get(key, type) {
      const value = values.get(key) ?? null;
      return type === 'json' && value ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

test('Run Now offers 30d, 1y, and 5y date choices', async () => {
  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentMessages.push({ url, body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: {} });
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/telegram/webhook', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            message_id: 1,
            chat: { id: 123 },
            from: { id: 123, first_name: 'Test' },
            text: 'Run Now',
          },
        }),
      }),
      {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '999',
        MEDBOT_KV: createKv({
          'user:123': JSON.stringify({ chatId: '123', status: 'approved' }),
        }),
      },
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(sentMessages[0].body.reply_markup.inline_keyboard, [[
      { text: 'Last 30 days', callback_data: 'run:30d' },
      { text: 'Last 1 year', callback_data: 'run:1y' },
      { text: 'Last 5 years', callback_data: 'run:5y' },
    ]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the 1y choice uses its expanded, date-filtered candidate search', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).startsWith('https://api.telegram.org')) {
      return Response.json({ ok: true, result: {} });
    }
    return Response.json({ esearchresult: { count: '0', idlist: [] } });
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/telegram/webhook', {
        method: 'POST',
        body: JSON.stringify({
          callback_query: {
            id: 'callback-id',
            data: 'run:1y',
            from: { id: 123 },
            message: { chat: { id: 123 }, message_id: 2 },
          },
        }),
      }),
      {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '999',
        NCBI_EMAIL: 'test@example.com',
        WOS_ENABLED: 'false',
        MEDBOT_KV: createKv({
          'user:123': JSON.stringify({ chatId: '123', status: 'approved' }),
        }),
      },
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    const entrezUrls = requests.filter(({ url }) => url.startsWith('https://eutils.ncbi.nlm.nih.gov'));
    assert.ok(entrezUrls.some(({ url }) => url.includes('reldate=365') && url.includes('retmax=0')));
    assert.ok(entrezUrls.some(({ url }) => url.includes('reldate=365') && url.includes('retmax=50')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
