/*
  bot.js — Telegram access-control + subscription bot
  Run persistently with: pm2 restart cholera-bot
*/

const https = require('https');
const path  = require('path');
const fs    = require('fs');
const Database = require('better-sqlite3');

// ===== Load .env =====
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] == null) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const PAGE_SIZE = 20;

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

// ===== Database =====
const db = new Database(path.join(__dirname, 'cases.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id  TEXT PRIMARY KEY,
    name     TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    blocked  INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS diseases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL,
    first_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id    TEXT    NOT NULL,
    disease_id INTEGER NOT NULL,
    PRIMARY KEY (chat_id, disease_id)
  );
`);

// Add blocked column if upgrading from older schema
try { db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0'); } catch {}

if (ADMIN_ID) {
  db.prepare('INSERT OR IGNORE INTO users (chat_id, name, approved, blocked, added_at) VALUES (?, ?, 1, 0, ?)')
    .run(ADMIN_ID, 'Admin', new Date().toISOString());
}

// ===== Telegram helpers =====
function telegramPost(method, data) {
  return new Promise(resolve => {
    const body = JSON.stringify(data);
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on('error', err => { console.error(`Telegram error (${method}):`, err.message); resolve({}); });
    req.write(body);
    req.end();
  });
}

function send(chatId, text, extra = {}) {
  return telegramPost('sendMessage', { chat_id: chatId, text, ...extra });
}
function editMessage(chatId, messageId, text, extra = {}) {
  return telegramPost('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
}
function answerCallback(id, text = '') {
  return telegramPost('answerCallbackQuery', { callback_query_id: id, text });
}

// ===== Keyboards =====
const ADMIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '👥 المستخدمون' }, { text: '🚫 المحظورون' }],
      [{ text: '🦠 الأمراض' },    { text: '📋 اشتراكاتي' }]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

const USER_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '🦠 الأمراض' }, { text: '📋 اشتراكاتي' }]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

// ===== Disease browser =====
function buildDiseasePage(chatId, page) {
  const all = db.prepare('SELECT id, name FROM diseases ORDER BY name').all();
  const total = all.length;

  if (total === 0) {
    return { text: 'لا توجد أمراض في النظام بعد.\nستظهر تلقائياً بعد أول تشغيل للبرنامج.', reply_markup: { inline_keyboard: [] } };
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const slice = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const subIds = new Set(
    db.prepare('SELECT disease_id FROM subscriptions WHERE chat_id = ?').all(chatId).map(r => r.disease_id)
  );

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    for (let j = 0; j < 2 && i + j < slice.length; j++) {
      const d = slice[i + j];
      row.push({ text: `${subIds.has(d.id) ? '✅' : '⬜'} ${d.name}`, callback_data: `toggle:${d.id}:${p}` });
    }
    rows.push(row);
  }

  const nav = [];
  if (p > 0)              nav.push({ text: '◀ السابق', callback_data: `page:${p - 1}` });
  nav.push({ text: `${p + 1} / ${totalPages}`, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: 'التالي ▶', callback_data: `page:${p + 1}` });
  rows.push(nav);
  rows.push([
    { text: '✅ اشتراك بالكل', callback_data: 'sub_all' },
    { text: '❌ إلغاء الكل',   callback_data: 'unsub_all' }
  ]);

  return {
    text: `🦠 الأمراض المتاحة (${total} مرض)\nاشتراكاتك الحالية: ${subIds.size}\n\nاضغط على مرض للاشتراك أو إلغائه:`,
    reply_markup: { inline_keyboard: rows }
  };
}

// ===== My subscriptions =====
function buildMySubscriptions(chatId) {
  const subs = db.prepare(`
    SELECT d.name FROM subscriptions s
    JOIN diseases d ON d.id = s.disease_id
    WHERE s.chat_id = ? ORDER BY d.name
  `).all(chatId);
  if (!subs.length) return '📋 لا توجد اشتراكات حالياً.\nاضغط على 🦠 الأمراض لاختيار ما تريد متابعته.';
  return `📋 اشتراكاتك الحالية (${subs.length}):\n\n` + subs.map(s => `• ${s.name}`).join('\n');
}

// ===== Users list (admin) — excludes blocked =====
function buildUsersMessage() {
  const rows = db.prepare('SELECT chat_id, name, approved FROM users WHERE blocked = 0 ORDER BY added_at').all();
  if (!rows.length) return { text: 'لا يوجد مستخدمون بعد.', reply_markup: { inline_keyboard: [] } };
  const lines = rows.map(r => `${r.approved ? '✅' : '⏳'} ${r.name || '—'} (${r.chat_id})`);
  const buttons = rows.map(r => [
    {
      text: r.approved ? `🚫 إلغاء ${r.name || r.chat_id}` : `✅ قبول ${r.name || r.chat_id}`,
      callback_data: r.approved ? `revoke:${r.chat_id}` : `approve:${r.chat_id}`
    },
    { text: '🔴 حظر', callback_data: `block:${r.chat_id}` }
  ]);
  return { text: `👥 المستخدمون (${rows.length}):\n\n` + lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

// ===== Blocked list (admin) =====
function buildBlockedMessage() {
  const rows = db.prepare('SELECT chat_id, name FROM users WHERE blocked = 1 ORDER BY added_at').all();
  if (!rows.length) return { text: 'لا يوجد مستخدمون محظورون.', reply_markup: { inline_keyboard: [] } };
  const lines = rows.map(r => `🔴 ${r.name || '—'} (${r.chat_id})`);
  const buttons = rows.map(r => [{
    text: `✅ إلغاء حظر ${r.name || r.chat_id}`,
    callback_data: `unblock:${r.chat_id}`
  }]);
  return { text: `🚫 المحظورون (${rows.length}):\n\n` + lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

// ===== Message handler =====
async function handleMessage(msg) {
  const chatId      = String(msg.chat.id);
  const text        = (msg.text || '').trim();
  const firstName   = msg.from?.first_name || '';
  const username    = msg.from?.username ? `@${msg.from.username}` : '';
  const displayName = [firstName, username].filter(Boolean).join(' ');

  const isAdmin  = chatId === ADMIN_ID;
  const userRow  = db.prepare('SELECT approved, blocked FROM users WHERE chat_id = ?').get(chatId);

  // ── Silently drop blocked users ──────────────────────────────
  if (userRow?.blocked === 1) return;

  const isApproved = userRow?.approved === 1;

  // ── Admin-only commands ──────────────────────────────────────
  if (isAdmin) {
    if (text === '👥 المستخدمون' || text === '/users') {
      const { text: t, reply_markup } = buildUsersMessage();
      await send(chatId, t, { reply_markup });
      return;
    }
    if (text === '🚫 المحظورون' || text === '/blocked') {
      const { text: t, reply_markup } = buildBlockedMessage();
      await send(chatId, t, { reply_markup });
      return;
    }
  }

  // ── Shared commands (approved users + admin) ─────────────────
  if (isApproved) {
    const kb = isAdmin ? ADMIN_KEYBOARD : USER_KEYBOARD;

    if (text === '🦠 الأمراض' || text === '/diseases') {
      const { text: t, reply_markup } = buildDiseasePage(chatId, 0);
      await send(chatId, t, { reply_markup });
      return;
    }
    if (text === '📋 اشتراكاتي' || text === '/mysubs') {
      await send(chatId, buildMySubscriptions(chatId), kb);
      return;
    }
    await send(chatId, '✅ أنت مشترك ونشط.\nاستخدم الأزرار أدناه للتحكم في اشتراكاتك.', kb);
    return;
  }

  // ── Unknown / unapproved user ────────────────────────────────
  db.prepare('INSERT OR IGNORE INTO users (chat_id, name, approved, blocked, added_at) VALUES (?, ?, 0, 0, ?)')
    .run(chatId, displayName, new Date().toISOString());
  db.prepare('UPDATE users SET name = ? WHERE chat_id = ?').run(displayName, chatId);

  await send(chatId,
    `👋 مرحباً ${firstName}!\n\n` +
    `معرّف محادثتك هو:\n${chatId}\n\n` +
    `أرسله للمسؤول لطلب الوصول.`
  );

  if (ADMIN_ID && chatId !== ADMIN_ID) {
    await send(ADMIN_ID,
      `🔔 طلب وصول جديد\nالاسم: ${displayName}\nالمعرّف: ${chatId}`,
      { reply_markup: { inline_keyboard: [[
        { text: '✅ قبول', callback_data: `approve:${chatId}` },
        { text: '🔴 حظر',  callback_data: `block:${chatId}`   }
      ]]}}
    );
  }
}

// ===== Callback query handler =====
async function handleCallbackQuery(cq) {
  const chatId  = String(cq.from.id);
  const data    = cq.data;
  const msgId   = cq.message?.message_id;
  const isAdmin = chatId === ADMIN_ID;
  const userRow = db.prepare('SELECT approved, blocked FROM users WHERE chat_id = ?').get(chatId);

  if (userRow?.blocked === 1) { await answerCallback(cq.id); return; }

  const isApproved = userRow?.approved === 1;

  // ── Admin-only actions ───────────────────────────────────────
  if (data.startsWith('approve:') || data.startsWith('revoke:') ||
      data.startsWith('block:')   || data.startsWith('unblock:')) {
    if (!isAdmin) { await answerCallback(cq.id, '⛔ غير مصرح.'); return; }

    const colon    = data.indexOf(':');
    const action   = data.slice(0, colon);
    const targetId = data.slice(colon + 1);

    if (action === 'approve') {
      db.prepare('INSERT OR IGNORE INTO users (chat_id, name, approved, blocked, added_at) VALUES (?, ?, 1, 0, ?)').run(targetId, '', new Date().toISOString());
      db.prepare('UPDATE users SET approved = 1, blocked = 0 WHERE chat_id = ?').run(targetId);
      await answerCallback(cq.id, '✅ تم القبول');
      await editMessage(chatId, msgId, cq.message.text + `\n\n✅ تم قبول ${targetId}`);
      await send(targetId, '✅ تم قبول طلبك!\nيمكنك الآن اختيار الأمراض التي تريد متابعتها.', USER_KEYBOARD);
      const { text: t, reply_markup } = buildDiseasePage(targetId, 0);
      await send(targetId, t, { reply_markup });
    }

    if (action === 'revoke') {
      db.prepare('UPDATE users SET approved = 0 WHERE chat_id = ?').run(targetId);
      await answerCallback(cq.id, '🚫 تم الإلغاء');
      await editMessage(chatId, msgId, cq.message.text + `\n\n🚫 تم إلغاء ${targetId}`);
    }

    if (action === 'block') {
      db.prepare('INSERT OR IGNORE INTO users (chat_id, name, approved, blocked, added_at) VALUES (?, ?, 0, 1, ?)').run(targetId, '', new Date().toISOString());
      db.prepare('UPDATE users SET approved = 0, blocked = 1 WHERE chat_id = ?').run(targetId);
      db.prepare('DELETE FROM subscriptions WHERE chat_id = ?').run(targetId);
      await answerCallback(cq.id, '🔴 تم الحظر');
      await editMessage(chatId, msgId, cq.message.text + `\n\n🔴 تم حظر ${targetId}`);
    }

    if (action === 'unblock') {
      db.prepare('UPDATE users SET blocked = 0 WHERE chat_id = ?').run(targetId);
      await answerCallback(cq.id, '✅ تم إلغاء الحظر');
      const { text: t, reply_markup } = buildBlockedMessage();
      await editMessage(chatId, msgId, t, { reply_markup });
    }

    return;
  }

  // ── Approved users: disease browser ─────────────────────────
  if (!isApproved) { await answerCallback(cq.id, '⛔ غير مصرح.'); return; }

  if (data === 'noop') { await answerCallback(cq.id); return; }

  if (data.startsWith('page:')) {
    const page = parseInt(data.split(':')[1], 10);
    const { text: t, reply_markup } = buildDiseasePage(chatId, page);
    await editMessage(chatId, msgId, t, { reply_markup });
    await answerCallback(cq.id);
    return;
  }

  if (data.startsWith('toggle:')) {
    const [, diseaseId, page] = data.split(':');
    const id = parseInt(diseaseId, 10);
    const p  = parseInt(page, 10);
    const already = db.prepare('SELECT 1 FROM subscriptions WHERE chat_id = ? AND disease_id = ?').get(chatId, id);
    if (already) {
      db.prepare('DELETE FROM subscriptions WHERE chat_id = ? AND disease_id = ?').run(chatId, id);
      await answerCallback(cq.id, '🔕 تم إلغاء الاشتراك');
    } else {
      db.prepare('INSERT OR IGNORE INTO subscriptions (chat_id, disease_id) VALUES (?, ?)').run(chatId, id);
      await answerCallback(cq.id, '🔔 تم الاشتراك');
    }
    const { text: t, reply_markup } = buildDiseasePage(chatId, p);
    await editMessage(chatId, msgId, t, { reply_markup });
    return;
  }

  if (data === 'sub_all') {
    const all = db.prepare('SELECT id FROM diseases').all();
    const ins = db.prepare('INSERT OR IGNORE INTO subscriptions (chat_id, disease_id) VALUES (?, ?)');
    for (const d of all) ins.run(chatId, d.id);
    await answerCallback(cq.id, '✅ تم الاشتراك في جميع الأمراض');
    const { text: t, reply_markup } = buildDiseasePage(chatId, 0);
    await editMessage(chatId, msgId, t, { reply_markup });
    return;
  }

  if (data === 'unsub_all') {
    db.prepare('DELETE FROM subscriptions WHERE chat_id = ?').run(chatId);
    await answerCallback(cq.id, '❌ تم إلغاء جميع الاشتراكات');
    const { text: t, reply_markup } = buildDiseasePage(chatId, 0);
    await editMessage(chatId, msgId, t, { reply_markup });
    return;
  }

  await answerCallback(cq.id);
}

// ===== Long-polling loop =====
async function poll() {
  let offset = 0;
  console.log('🤖 Bot is running...');
  while (true) {
    try {
      const res = await telegramPost('getUpdates', { offset, timeout: 30 });
      if (res.ok && res.result?.length) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.message)        await handleMessage(update.message).catch(e => console.error(e.message));
          if (update.callback_query) await handleCallbackQuery(update.callback_query).catch(e => console.error(e.message));
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

poll();
