import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

test('one-time searches are repeatable and leave scheduled settings and deduplication untouched', async () => {
  const values = new Map(Object.entries({
    'user:123': JSON.stringify({ chatId: '123', status: 'approved' }),
    'user:123:keywords': JSON.stringify({ terms: ['malaria'] }),
    'user:123:schedule': JSON.stringify({ time: '09:30', enabled: true }),
    'run:last:123': 'existing last run',
  }));
  const initialSettings = [...values].filter(([key]) => /keywords|schedule|run:last/.test(key));
  const writes = [];
  const kv = {
    async get(key, type) {
      if (key.startsWith('sent:')) throw new Error('one-time search read scheduled deduplication');
      const value = values.get(key) ?? null;
      return type === 'json' && value ? JSON.parse(value) : value;
    },
    async put(key, value) { writes.push(key); values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org')) {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true, result: {} });
    }
    const parsed = new URL(url);
    requests.push({ url });
    if (parsed.pathname.endsWith('esearch.fcgi')) {
      return Response.json({ esearchresult: { count: '1', idlist: parsed.searchParams.get('db') === 'pubmed' ? ['42'] : [] } });
    }
    if (parsed.pathname.endsWith('esummary.fcgi')) {
      return Response.json({ result: { uids: ['42'], '42': { title: 'Matching article', pubtype: ['Clinical Trial'] } } });
    }
    return new Response('<PubmedArticle><PMID>42</PMID></PubmedArticle>');
  };
  const env = { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '999', NCBI_EMAIL: 'test@example.com', NCBI_API_KEY: 'key', WOS_ENABLED: 'false', MEDBOT_KV: kv };
  async function update(payload) {
    const response = await worker.fetch(new Request('https://example.com/telegram/webhook', { method: 'POST', body: JSON.stringify(payload) }), env, { waitUntil() {} });
    assert.equal(response.status, 200, await response.text());
  }
  const message = (text) => ({ message: { message_id: 1, chat: { id: 123 }, from: { id: 123 }, text } });
  try {
    await update(message('/ping'));
    assert.deepEqual(requests.at(-1).body.reply_markup.keyboard[0].map((button) => button.text), ['Cron', 'One-time', 'Review Articles']);
    for (const [range, days] of [['30d', '30'], ['1y', '365'], ['5y', '1825']]) {
      await update(message('One-time'));
      await update(message('dengue, vaccine'));
      assert.deepEqual(requests.at(-1).body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), ['once:30d', 'once:1y', 'once:5y']);
      await update({ callback_query: { id: 'cb', data: `once:${range}`, from: { id: 123 }, message: { chat: { id: 123 }, message_id: 2 } } });
      assert.ok(requests.some(({ url }) => url.includes(`reldate=${days}`) && url.includes('dengue')));
    }
    assert.equal(requests.filter(({ body }) => body?.text?.includes('Matching article')).length, 3);
    assert.deepEqual([...values].filter(([key]) => /keywords|schedule|run:last/.test(key)), initialSettings);
    assert.ok(!writes.some((key) => key.startsWith('sent:') || key.startsWith('digest:') || key.startsWith('run:last')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
