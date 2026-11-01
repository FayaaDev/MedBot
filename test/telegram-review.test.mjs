import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

test('review flow gates access and sends URL or downloaded PDF and references to processor', async () => {
  const values = new Map([['user:123', JSON.stringify({ chatId: '123', status: 'approved' })]]);
  const kv = {
    async get(key, type) { const value = values.get(key); return type === 'json' && value ? JSON.parse(value) : value ?? null; },
    async put(key, value, options) { if (key.startsWith('telegram:keyword-flow:')) assert.equal(options.expirationTtl, 600); values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const requests = [];
  let failProcessor = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    requests.push({ url, options });
    if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'documents/test.pdf' } });
    if (url.includes('/file/bot')) return new Response('%PDF-test');
    if (url.endsWith('/process')) return failProcessor
      ? Response.json({ error: 'No accessible public PDF found on article page' }, { status: 422 })
      : Response.json({ accepted: true }, { status: 202 });
    return Response.json({ ok: true, result: {} });
  };
  const env = { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '999', ASREVIEW_URL: 'https://review.example', ASREVIEW_TOKEN: 'secret', MEDBOT_KV: kv };
  async function send(content, id = 123) {
    const pending = [];
    const body = { message: { message_id: 1, chat: { id }, from: { id }, ...content } };
    const response = await worker.fetch(new Request('https://example.com/telegram/webhook', { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil(promise) { pending.push(promise); } });
    assert.equal(response.status, 200, await response.text());
    await Promise.all(pending);
  }
  try {
    await send({ text: 'Review Articles' }, 456);
    assert.ok(!values.has('telegram:keyword-flow:456'));
    await send({ text: 'Review Articles' });
    await send({ text: '10.1234/example' });
    await send({ text: '15-25,31' });
    await send({ text: 'Review Articles' });
    await send({ document: { file_id: 'pdf-id', file_name: 'review.pdf', mime_type: 'application/pdf' } });
    await send({ text: '1,3' });
    const calls = requests.filter(({ url }) => url.endsWith('/process'));
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.options.headers.authorization, 'Bearer secret');
      const form = await new Response(call.options.body, { headers: { 'content-type': call.options.headers['content-type'] } }).formData();
      assert.equal(form.get('refs'), index ? '1,3' : '15-25,31');
      assert.equal(form.get('telegram_token'), 'token');
      assert.equal(form.get('chat_id'), '123');
      assert.equal(form.get('url'), index ? null : '10.1234/example');
      assert.equal(index ? await form.get('pdf').text() : form.get('pdf'), index ? '%PDF-test' : null);
    }
    assert.equal(requests.filter(({ url }) => url.endsWith('/sendDocument')).length, 0);
    assert.ok(requests.some(({ options }) => typeof options.body === 'string' && JSON.parse(options.body).text?.includes('Review accepted')));
    failProcessor = true;
    await send({ text: 'Review Articles' });
    await send({ text: 'https://example.com/article' });
    await send({ text: '1' });
    assert.match(JSON.parse(requests.at(-1).options.body).text, /No accessible public PDF/);
    assert.equal(requests.filter(({ url }) => url.endsWith('/sendDocument')).length, 0);
    await send({ text: 'Review Articles' });
    await send({ text: 'cancel' });
    assert.ok(!values.has('telegram:keyword-flow:123'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
