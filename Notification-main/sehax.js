/*Install: 
npm i playwright
npm i better-sqlite3
npx playwright install chromium
*/

// seha-login-expand-click.js
// Run: node sehax.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const cp = require('child_process');

const DOWNLOAD_DIR = __dirname;

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, '.env'));

// ===== Process lock (prevent multiple simultaneous runs) =====
const LOCK_FILE = path.join(__dirname, 'sehax.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0); // throws if PID is not running
      console.error(`⛔ Another instance is already running (PID ${pid}). Exiting.`);
      process.exit(0);
    } catch {
      console.log(`🗑️  Stale lock file (PID ${pid} is gone). Removing and continuing.`);
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function syncLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'run.log'), line); } catch {}
  process.stderr.write(line);
}

process.on('exit', releaseLock);
process.on('SIGINT',  () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
process.on('uncaughtException', err => { syncLog(`💥 Uncaught exception: ${err.stack || err.message}`); process.exit(1); });
process.on('unhandledRejection', (reason) => { syncLog(`💥 Unhandled rejection: ${reason?.stack || reason}`); process.exit(1); });

acquireLock();

// ===== Global max-runtime guard (25 min) =====
const _maxRuntimeTimer = setTimeout(() => {
  console.error('⏰ Max runtime of 25 minutes exceeded. Forcing exit to avoid zombie process.');
  process.exit(1);
}, 25 * 60 * 1000);
_maxRuntimeTimer.unref(); // won't keep the process alive on its own

// ===== SQLite setup =====
const db = new Database(path.join(__dirname, 'cases.db'), { timeout: 5000 });
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_cases (
    investigation_id TEXT PRIMARY KEY,
    disease          TEXT NOT NULL,
    detected_at      TEXT NOT NULL
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

// Region name lookup — maps full Arabic directorate names to short region names
const REGION_MAP = {
  'المديرية العامة للشؤون الصحية بالقصيم':                'القصيم',
  'المديرية العامة للشؤون الصحية بالمنطقة الشرقية':       'المنطقة الشرقية',
  'المديرية العامة للشؤون الصحية بمنطقة الرياض':          'الرياض',
  'المديرية العامة للشؤون الصحية بمنطقة تبوك':            'تبوك',
  'المديرية العامة للشؤون الصحية بمنطقة مكة المكرمة':     'مكة المكرمة',
  'المديرية العامة للشؤون الصحية في الباحة':              'الباحة',
  'المديرية العامة للشؤون الصحية في الجوف':               'الجوف',
  'المديرية العامة للشؤون الصحية في الحدود الشمالية':     'الحدود الشمالية',
  'المديرية العامة للشؤون الصحية في المدينة المنورة':     'المدينة المنورة',
  'المديرية العامة للشؤون الصحية في جازان':               'جازان',
  'المديرية العامة للشؤون الصحية في حائل':                'حائل',
  'المديرية العامة للشؤون الصحية في عسير':                'عسير',
  'المديرية العامة للشؤون الصحية في نجران':               'نجران',
  'مديرية الشؤون الصحية بمحافظة الإحساء':                 'الإحساء',
  'مديرية الشؤون الصحية بمحافظة الطائف':                  'الطائف',
  'مديرية الشؤون الصحية بمحافظة القريات':                 'القريات',
  'مديرية الشؤون الصحية بمحافظة القنفذة':                 'القنفذة',
  'مديرية الشؤون الصحية بمحافظة جدة':                     'جدة',
  'مديرية الشؤون الصحية بمحافظة حفر الباطن':              'حفر الباطن',
  'مديرية الشؤون الصحية في بيشة':                         'بيشة',
};

function resolveRegion(raw) {
  const key = String(raw || '').trim();
  return REGION_MAP[key] || 'غير معروف';
}

// Parse an Excel investigation file, return array of { id, disease, region }
function parseInvestigationFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (rows.length === 0) return [];
  const firstRow = rows[0];
  if (!('Investigation' in firstRow) || !('Disease' in firstRow)) {
    console.warn('⚠️ Could not find Investigation/Disease columns. Columns found:', Object.keys(firstRow).join(' | '));
    return [];
  }
  return rows
    .map(r => ({
      id:      String(r['Investigation']).trim(),
      disease: String(r['Disease']).trim(),
      region:  resolveRegion(r['Reporting Organization Directorate']),
    }))
    .filter(r => r.id && r.disease);
}

// Register any new disease names into the diseases table
function upsertDiseases(cases) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO diseases (name, first_seen) VALUES (?, ?)'
  );
  const now = new Date().toISOString();
  for (const c of cases) insert.run(c.disease, now);
}

// Insert cases into SQLite, return only the ones that were not seen before
function filterNewCases(cases) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO seen_cases (investigation_id, disease, detected_at) VALUES (?, ?, ?)'
  );
  const now = new Date().toISOString();
  return cases.filter(c => insert.run(c.id, c.disease, now).changes > 0);
}

// Send a Telegram message to one chat ID
function telegramSend(token, chatId, text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', err => { console.warn(`⚠️ Telegram send failed to ${chatId}: ${err.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// Notify users subscribed to the disease of a new case
async function notifyCase({ id, disease, region }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn('⚠️ TELEGRAM_BOT_TOKEN not set, skipping notification.'); return; }
  const users = db.prepare(`
    SELECT u.chat_id FROM users u
    JOIN subscriptions s ON s.chat_id = u.chat_id
    JOIN diseases d ON d.id = s.disease_id
    WHERE u.approved = 1 AND d.name = ?
  `).all(disease);
  if (!users.length) return;
  const text = `🚨 حالة جديدة\nرقم التقصي: ${id}\nالمرض: ${disease}\nالمنطقة: ${region}`;
  for (const user of users) {
    await telegramSend(token, user.chat_id, text);
  }
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Helper to export with retries
async function exportWithRetry({ frame, page, exportSel, waitBetweenMs = 120000, maxAttempts = Number(process.env.SEHA_MAX_EXPORT_ATTEMPTS || 0) }) {
  let attempt = 0;
  while (true) {
    attempt++;
    console.log(`📦 Export attempt #${attempt} …`);
    const exportBtn = frame.locator(exportSel).first();
    await Promise.race([
      frame.locator('[role="progressbar"], .loading, .spinner').waitFor({ state: 'detached', timeout: 30000 }).catch(()=>{}),
      sleep(500)
    ]);
    await exportBtn.waitFor({ state: 'visible', timeout: 0 }).catch(()=>{});
    await exportBtn.scrollIntoViewIfNeeded().catch(()=>{});

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);

    try { await exportBtn.click({ timeout: 0 }); }
    catch {
      try { await exportBtn.click({ force: true, timeout: 0 }); }
      catch {
        const h = await exportBtn.elementHandle({ timeout: 0 }).catch(()=>null);
        if (h) await page.evaluate(el => el.click?.(), h).catch(()=>{});
      }
    }

    const dl = await downloadPromise;
    if (dl) {
      let filename = 'export';
      try { filename = dl.suggestedFilename(); } catch {}
      const savePath = path.join(DOWNLOAD_DIR, filename);
      await dl.saveAs(savePath).catch(()=>{});
      console.log(`✅ Download confirmed and saved: ${savePath}`);
      return savePath;
    }

    console.warn('⚠️ No download detected. Retrying …');
    if (maxAttempts > 0 && attempt >= maxAttempts) throw new Error(`Export failed after ${attempt} attempts.`);

    // After 3 failed attempts, check for session expiry
    if (attempt >= 3) {
      const currentUrl = page.url();
      if (/login|account\/login/i.test(currentUrl)) {
        throw new Error('Session expired — page redirected to login. Aborting export.');
      }
      const iframeCount = await page.locator('#contentIframe').count().catch(() => 0);
      if (!iframeCount) {
        throw new Error('Session expired — content iframe is gone. Aborting export.');
      }
    }

    await sleep(waitBetweenMs);
  }
}

// ===== OUTLOOK OTP SECTION =====
const vbsScript = `
Set outlook = CreateObject("Outlook.Application")
Set ns = outlook.GetNamespace("MAPI")
Set inbox = ns.GetDefaultFolder(6)
inbox.Sort "[ReceivedTime]", True

Dim msg, otp
For Each msg In inbox.Items
    If InStr(LCase(msg.Subject), "رمز") > 0 Or InStr(LCase(msg.Subject), "verification") > 0 Then
        Dim body
        body = msg.Body
        Dim re
        Set re = New RegExp
        re.Pattern = "\\b[0-9]{4,8}\\b"
        re.Global = True
        Dim matches
        Set matches = re.Execute(body)
        If matches.Count > 0 Then
            otp = matches(0).Value
            Exit For
        End If
    End If
Next

If otp <> "" Then
    WScript.Echo otp
Else
    WScript.Echo "NO_OTP_FOUND"
End If
`;

function getOutlookOTP() {
 return new Promise((resolve, reject) => {
  const cp = require('child_process');
  const vbsPath = "C:\\Users\\Admin\\OneDrive\\Desktop\\Scabies\\getotp.vbs";
  const child = cp.spawn('cscript', ['//Nologo', vbsPath]);

  let output = '';
  child.stdout.on('data', d => output += d.toString());
  child.stderr.on('data', d => console.error(d.toString()));
  child.on('error', err => reject(err));
  child.on('close', () => {
    const match = output.match(/\b\d{4,8}\b/);
    if (match) resolve(match[0]);
    else reject(new Error(`⚠️ VBScript returned no OTP. Raw output:\n${output}`));
  });
});

}



// ===== OTP API SECTION =====
const http = require('http');
const https = require('https');

function fetchN8nOtp() {
  return new Promise((resolve, reject) => {
    const webhookUrl = process.env.N8N_OTP_URL;
    const apiKey = process.env.N8N_OTP_API_KEY || '';
    if (!webhookUrl) {
      reject(new Error('N8N_OTP_URL is not set.'));
      return;
    }
    if (!apiKey) {
      reject(new Error('N8N_OTP_API_KEY is not set.'));
      return;
    }

    let url;
    try {
      url = new URL(webhookUrl);
    } catch (err) {
      reject(new Error(`Invalid N8N_OTP_URL: ${webhookUrl}`));
      return;
    }

    const method = (process.env.N8N_OTP_METHOD || 'GET').toUpperCase();
    const timeoutMs = Number(process.env.N8N_OTP_TIMEOUT_MS || 60000);
    const debug = String(process.env.N8N_OTP_DEBUG || '').toLowerCase() === 'true';
    const bodyPayload = process.env.N8N_OTP_BODY || '';
    const bodyLength = Buffer.byteLength(bodyPayload);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      'Accept': 'application/json,text/plain,*/*'
    };
    if (bodyPayload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyLength;
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => {
          if (debug) {
            console.log(`OTP status: ${res.statusCode}`);
            console.log(`OTP raw (first 300 chars): ${body.slice(0, 300)}`);
          }
          if (res.statusCode === 401) {
            reject(new Error(`Unauthorized: ${body.slice(0, 200)}`));
            return;
          }
          if (res.statusCode === 404 || res.statusCode === 410) {
            resolve(null);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }

          const trimmed = body.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed);
              const first = Array.isArray(parsed) ? parsed[0] : parsed;
              const direct = first?.otp ?? first?.OTP ?? first?.code ?? first?.Code;
              const maxAgeSeconds = Number(process.env.N8N_OTP_MAX_AGE_SECONDS || 0);
              if (maxAgeSeconds > 0 && Number.isFinite(first?.ageSeconds) && first.ageSeconds > maxAgeSeconds) {
                resolve(null);
                return;
              }
              const fromBody =
                first?.body &&
                typeof first.body === 'object' &&
                Object.keys(first.body).join(' ');
              const otpText = [direct, fromBody]
                .map(v => (typeof v === 'string' ? v : v == null ? '' : String(v)))
                .join(' ');
              const match = otpText.match(/\b\d{4,8}\b/);
              if (match) {
                resolve(match[0]);
                return;
              }
            } catch (err) {
              // Fall through to regex on raw body
            }
          }

          const match = body.match(/\b\d{4,8}\b/);
          if (match) resolve(match[0]);
          else reject(new Error(`No 4-8 digit OTP found in webhook response: ${body.slice(0, 200)}`));
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('N8N webhook request timed out'));
    });
    if (bodyPayload) {
      req.write(bodyPayload);
    }
    req.end();
  });
}

// ===== Playwright helpers =====
async function fillFirstAvailable(scope, selectors, value) {
  for (const sel of selectors) {
    const el = scope.locator(sel).first();
    if (await el.count()) {
      await el.click({ timeout: 10000 });
      await el.fill(value, { timeout: 10000 });
      return true;
    }
  }
  return false;
}

async function clickFirstAvailable(scope, selectors) {
  for (const sel of selectors) {
    const el = scope.locator(sel).first();
    if (await el.count()) {
      await el.click({ timeout: 10000 });
      return true;
    }
  }
  return false;
}

// ===== MAIN SCRIPT =====
(async () => {

const isInteractive = process.stdout.isTTY; // true when run from terminal, false from cron
const browser = await chromium.launch({ headless: !isInteractive });
const context = await browser.newContext({
  acceptDownloads: true,
  downloadsPath: __dirname
});
const page = await context.newPage();


 // 1️⃣ Login
await page.goto('https://www.seha.sa/#/account/login', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle');

// 🔹 Fill National ID / Iqama
const idInput = page.locator('label:has-text("رقم الهوية / الإقامة")')
                    .locator('xpath=following-sibling::input[1]');
await idInput.waitFor({ state: 'visible', timeout: 15000 });
await idInput.fill(process.env.SEHA_ID || '');

// 🔹 Fill Password
const passInput = page.locator('label:has-text("كلمة المرور")')
                      .locator('xpath=following-sibling::input[1]');
await passInput.waitFor({ state: 'visible', timeout: 15000 });
await passInput.fill(process.env.SEHA_PW || '');

// 🔹 Click the Login button
await clickFirstAvailable(page, [
  'button[type="submit"]',
  'button:has-text("تسجيل الدخول")',
  'button:has-text("Login")'
]);

 // 2️⃣ Choose Email login
console.log('📨 Waiting for OTP method buttons to appear...');

await page.waitForSelector('button.btn-otp:has-text("رسالة نصية")', { timeout: 20000 });

const smsOtpButton = page.locator('button.btn-otp:has-text("رسالة نصية")').first();
await smsOtpButton.scrollIntoViewIfNeeded().catch(() => {});
await smsOtpButton.click({ timeout: 10000 });

console.log('✅ Clicked "رسالة نصية" to request OTP via SMS.');
console.log('⏳ Waiting 30 seconds before checking N8N (to allow SEHA to send new OTP)...');
await page.waitForTimeout(30000);



// 3️⃣ Wait for OTP email (retry every 5 seconds)
console.log('📧 Waiting for OTP from N8N webhook...');

let otp, attempts = 0;
while (!otp && attempts < 12) { // 1 minute max (12 × 5s)
  attempts++;
  try {
    otp = await fetchN8nOtp();
    if (otp) {
      console.log(`✅ OTP fetched after ${attempts} attempt(s): ${otp}`);
      break;
    }
    console.log(`⏳ Attempt ${attempts}: no OTP yet (empty response), retrying in 5 seconds...`);
    await page.waitForTimeout(5000);
  } catch (err) {
    console.log(`⏳ Attempt ${attempts}: OTP fetch error: ${err.message}`);
    console.log('⏳ Retrying in 5 seconds...');
    await page.waitForTimeout(5000);
  }
}

if (!otp) {
  console.error('⚠️ Gave up: no OTP received after 1 minute.');
  await browser.close();
  process.exit(1);
}

// 4️⃣ Wait for OTP input field and fill it
console.log('🧩 Waiting for OTP input field...');
const otpInputSelector = 'input[placeholder*="رمز" i], input[type="number"], input[formcontrolname*="otp" i], input[name="otp" i], input[id*="otp" i], input[type="tel"]';
const otpInput = page.locator(otpInputSelector).first();
const otpInputCount = await page.locator(otpInputSelector).count().catch(() => 0);
console.log(`🧪 OTP input candidates found: ${otpInputCount}`);
await otpInput.waitFor({ state: 'visible', timeout: 30000 });
await otpInput.scrollIntoViewIfNeeded().catch(() => {});
await otpInput.fill(otp);
console.log(`✅ OTP ${otp} filled successfully!`);

// 5️⃣ Click Verify ("تحقق")
await page.waitForSelector('button:has-text("تحقق"), button:has-text("Verify")', { timeout: 20000 });
const verifyBtn = page.locator('button:has-text("تحقق"), button:has-text("Verify")').first();
await verifyBtn.scrollIntoViewIfNeeded().catch(() => {});
await verifyBtn.click({ timeout: 10000 });
console.log('✅ OTP submitted successfully!');

  // Continue with your SEHA automation from here ↓
  console.log('🏁 Login complete — continuing automation…');


// Expand Ant Design submenu "ادارة نظام حصن" using its trigger class,
// then click the menu item "منسق الأمراض المعدية".

async function expandAntSubmenuByTitle(page, title) {
  // The clickable trigger in Ant Design submenus is `.ant-menu-submenu-title`
  const trigger = page.locator(`.ant-menu-submenu-title:has-text("${title}")`).first();

  // Make sure it's on screen
  await trigger.scrollIntoViewIfNeeded().catch(() => {});

  // If not expanded, click and wait for aria-expanded="true"
  let expanded = await trigger.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await trigger.click({ timeout: 10000 });
    await page.waitForSelector(
      `.ant-menu-submenu-title[aria-expanded="true"]:has-text("${title}")`,
      { timeout: 10000 }
    );
  }
}

//
// ---- call it after you submit the OTP and the post-login menu is visible ----
//

// 1) expand "ادارة نظام حصن"
await expandAntSubmenuByTitle(page, 'ادارة نظام حصن');

// 2) click the desired child item
const childItem = page.locator(
  [
    '[role="menuitem"]:has-text("مدير حصن لوحدة التقصيات")', // preferred (AntD sets role)
    'a:has-text("مدير حصن لوحدة التقصيات")',
    'button:has-text("مدير حصن لوحدة التقصيات")'
  ].join(', ')
).first();

// Ensure it’s visible (submenu just expanded)
await childItem.waitFor({ state: 'visible', timeout: 10000 });
await childItem.click({ timeout: 10000 });

console.log('✅ Expanded "ادارة نظام حصن" and clicked "منسق الأمراض المعدية"');

// === WAIT 20 SECONDS BEFORE NEXT TASK ===
console.log('⏳ Waiting 20 seconds before proceeding...');
await page.waitForTimeout(10000);

// === NEW TASK ===
// Expand submenu with aria-expanded="false" then click "حصن بلس"

const collapsedSubmenu = page.locator('.ant-menu-submenu-title[aria-expanded="false"]').first();
if (await collapsedSubmenu.count()) {
  await collapsedSubmenu.scrollIntoViewIfNeeded().catch(() => {});
  await collapsedSubmenu.click({ timeout: 10000 });
  await page.waitForSelector('.ant-menu-submenu-title[aria-expanded="true"]', { timeout: 10000 });
  console.log('🔽 Expanded submenu that was previously collapsed');
}

// Click "حصن بلس"
const hisnPlusItem = page.locator(
  [
    '[role="menuitem"]:has-text("حصن بلس")',
    'a:has-text("حصن بلس")',
    'button:has-text("حصن بلس")'
  ].join(', ')
).first();

await hisnPlusItem.waitFor({ state: 'visible', timeout: 10000 });
await hisnPlusItem.click({ timeout: 10000 });

console.log('✅ Clicked "حصن بلس" successfully');

// === Inside "حصن بلس": switch into the iframe and open التقصيات, then export ===

// 1) Wait for the iframe to be present & loaded (no hard timeout to avoid 15s errors)
await page.waitForSelector('#contentIframe', { state: 'attached', timeout: 0 });

// Use frameLocator so all selectors are scoped inside the iframe
const contentFrame = page.frameLocator('#contentIframe');

// Wait for the iframe's "Please wait..." loading screen to disappear before interacting
console.log('⏳ Waiting for iframe to finish loading...');
await contentFrame.locator(':text("Please wait")').waitFor({ state: 'hidden', timeout: 120000 }).catch(() => {});

// === Open وحدة التقصيات, then التقصيات ===

// 1) Click "وحدة التقصيات"
const investigationUnit = contentFrame.locator(
  [
    'button:has-text("وحدة التقصيات")',
    'a:has-text("وحدة التقصيات")',
    '[role="menuitem"]:has-text("وحدة التقصيات")',
    ':text("وحدة التقصيات")'
  ].join(', ')
).first();

try {
    await investigationUnit.waitFor({ state: 'visible', timeout: 120000 });
    await investigationUnit.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await investigationUnit.click({ timeout: 0 });
    } catch {
      try {
        await investigationUnit.click({ force: true, timeout: 0 });
      } catch {
        const handle = await investigationUnit.elementHandle().catch(() => null);
        if (handle) await contentFrame.page().evaluate(el => el.click?.(), handle);
      }
    }
} catch (error) {
    console.log('Error finding or clicking "وحدة التقصيات". Saving screenshot...');
    await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
    console.log('Screenshot saved to debug_screenshot.png');
    throw error; // Re-throw the original error
}
console.log('✅ Clicked "وحدة التقصيات"');

// 2) Wait for page or tab to fully load
await Promise.race([
  contentFrame.locator('[role="progressbar"], .loading, .spinner').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {}),
  contentFrame.locator('#InvestigationModule, #InvestigationTabContainer, :text("التقصيات")').waitFor({ state: 'visible', timeout: 120000 }).catch(() => {}),
  page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {})
]);
console.log('⌛ Page for "وحدة التقصيات" fully loaded.');

// 3) Click "التقصيات"
const investigationsTab = contentFrame.locator(
  [
    '#InvestigationTabContainer',
    'button:has-text("التقصيات")',
    'a:has-text("التقصيات")',
    ':text("التقصيات")'
  ].join(', ')
).first();

await investigationsTab.scrollIntoViewIfNeeded().catch(() => {});
try {
  await investigationsTab.click({ timeout: 0 });
} catch {
  try {
    await investigationsTab.click({ force: true, timeout: 0 });
  } catch {
    const handle = await investigationsTab.elementHandle().catch(() => null);
    if (handle) await contentFrame.page().evaluate(el => el.click?.(), handle);
  }
}

console.log('✅ Opened "التقصيات" tab successfully');

// ⏳ Wait 2 seconds to ensure tab fully loaded
await page.waitForTimeout(2000);

await contentFrame.locator('#InvestigationFilters').waitFor({ state: 'visible', timeout: 0 });
await contentFrame.locator('#b18-Column3 #Disease .choices').waitFor({ state: 'visible', timeout: 0 });

// Helper to select an item from a Choices.js dropdown by visible text
// `frame` here is your FrameLocator (e.g., contentFrame)
async function selectFromChoicesByText(frame, containerSelector, optionText, searchText) {
  const root = frame.locator(containerSelector).first();

  // 1) Open dropdown
  const inputArea = root.locator('.choices__inner, .search--wrapper input.choices__input--cloned').first();
  await inputArea.scrollIntoViewIfNeeded().catch(() => {});
  try { await inputArea.click({ timeout: 0 }); } catch { await inputArea.click({ force: true, timeout: 0 }).catch(()=>{}); }

  // 2) Ensure dropdown visible
  const dropdown = root.locator('.choices__list--dropdown, .choices__list[role="listbox"]').first();
  await dropdown.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  // 3) Type to filter (if cloned input exists)
  const cloned = root.locator('.search--wrapper input.choices__input--cloned').first();
  if (await cloned.count()) {
    await cloned.fill('');
    await cloned.type(searchText || optionText, { delay: 20 }).catch(()=>{});
  }

  // 4) Choose option — try exact text first, fall back to search text (handles * prefix)
  let option = dropdown.locator('.choices__item[role="option"]', { hasText: optionText }).first();
  const optionVisible = await option.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!optionVisible) {
    // * prefix may not appear in dropdown — try matching by search text instead
    const fallback = searchText || optionText.replace(/^\*/, '');
    option = dropdown.locator('.choices__item[role="option"]', { hasText: fallback }).first();
    const fallbackVisible = await option.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!fallbackVisible) {
      console.warn(`⚠️ Option "${optionText}" not found in dropdown, skipping`);
      await frame.locator('#b4-tabscontent').first().click({ position: { x: 10, y: 6 }, timeout: 0 }).catch(() => {});
      return;
    }
  }
  await option.scrollIntoViewIfNeeded().catch(() => {});
  try { await option.click({ timeout: 10000 }); }
  catch { try { await option.click({ force: true, timeout: 10000 }); }
         catch { const h = await option.elementHandle({ timeout: 5000 }).catch(()=>null); if (h) await option.evaluate(el => el.click?.()); } }

  // 5) Wait for token/badge confirming selection
  const token = root.locator('.choices__list--multiple .choices__item.choices__item--selectable', { hasText: optionText }).first();
  await token.waitFor({ state: 'visible', timeout: 5000 }).catch(()=>{});

  // 6) CLOSE the dropdown by clicking the upper border of #b4-tabscontent
  //    (inside the iframe; no global coordinates needed)
  const upperBorder = frame.locator('#b4-tabscontent').first();
  if (await upperBorder.count()) {
    // click near the top edge so we don't hit any controls
    await upperBorder.click({ position: { x: 10, y: 6 }, timeout: 0 }).catch(()=>{});
  } else {
    // fallback: click an empty corner in the filters area
    await frame.locator('#InvestigationFilters').click({ position: { x: 2, y: 2 }, timeout: 0 }).catch(()=>{});
  }

  // 7) Confirm closed (don’t block the run if it’s stubborn)
  await dropdown.waitFor({ state: 'hidden', timeout: 1500 }).catch(()=>{});
  await inputArea.blur().catch(()=>{});
}
 
 // No disease filter applied — all today's cases are downloaded and filtered in code

// === Set date range to today only ===
const today = new Date();
const todayStr = today.toISOString().split('T')[0].replace(/-/g, '/');
const startDateStr = todayStr;
const endDateStr = todayStr;

console.log(`📅 Date range set to today: ${todayStr}`);

// Helper: set a date in a column input and fire events
async function setDateInColumn(frame, columnId, dateStr) {
  const input = frame.locator(
    `#${columnId} input[type="date"], ` +
    `#${columnId} input.form-control, ` +
    `#${columnId} input[type="text"]`
  ).first();

  await input.waitFor({ state: 'visible', timeout: 0 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  try { await input.click({ timeout: 0 }); } catch { await input.click({ force: true, timeout: 0 }).catch(()=>{}); }

  try { await input.fill(''); } catch {}
  await input.type(dateStr, { delay: 15 }).catch(async () => { await input.fill(dateStr).catch(()=>{}); });
  await input.press('Enter').catch(()=>{});

  const h = await input.elementHandle({ timeout: 0 }).catch(() => null);
  if (h) {
    await page.evaluate(el => {
      try { el.dispatchEvent(new Event('input',  { bubbles: true })); } catch {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      if (typeof el.blur === 'function') el.blur();
    }, h).catch(()=>{});
  }
}

await setDateInColumn(contentFrame, 'b21-Column3', startDateStr);
await setDateInColumn(contentFrame, 'b21-Column4', endDateStr);
console.log(`📅 Date range set: ${startDateStr} → ${endDateStr}`);

// === Click Search ===
const searchBtn = contentFrame.locator('#InvestigationSearchBtn').first();
await searchBtn.scrollIntoViewIfNeeded().catch(() => {});
try { await searchBtn.click({ timeout: 0 }); }
catch { try { await searchBtn.click({ force: true, timeout: 0 }); }
       catch {
         const h = await searchBtn.elementHandle({ timeout: 0 }).catch(()=>null);
         if (h) await page.evaluate(el => el.click?.(), h).catch(()=>{});
       } }
console.log('🔎 Triggered Investigation search');

// Wait for results to load
await Promise.race([
  contentFrame.locator('[role="progressbar"], .loading, .spinner').waitFor({ state: 'detached', timeout: 120000 }).catch(()=>{}),
  contentFrame.locator('#InvestigationGrid, .table, [role="table"]').waitFor({ state: 'visible', timeout: 120000 }).catch(()=>{}),
  page.waitForLoadState('networkidle', { timeout: 120000 }).catch(()=>{})
]);

// === WAIT 5 SECONDS before export ===
console.log('⏳ Waiting 15 seconds before exporting...');
await page.waitForTimeout(15000);

// === Export investigations with retries ===
const savedPath = await exportWithRetry({
  frame: contentFrame,
  page,
  exportSel: '#ExportInvestigations',
  waitBetweenMs: 20000,
});

console.log('⬇️ Final export saved at:', savedPath);

// === Parse, deduplicate, notify, then delete the file ===
const allCases = parseInvestigationFile(savedPath);
console.log(`📋 Parsed ${allCases.length} case(s) from export`);
upsertDiseases(allCases);
const newCases = filterNewCases(allCases);
console.log(`🆕 ${newCases.length} new case(s) to notify`);
for (const c of newCases) {
  await notifyCase(c);
  console.log(`📨 Notified: ${c.id} — ${c.disease}`);
  await sleep(500);
}
fs.unlinkSync(savedPath);
console.log('🗑️ Export file deleted');

// === Refresh the page after download ===
try {
  console.log('🔄 Refreshing the page...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  console.log('✅ Page refreshed successfully.');
} catch (err) {
  console.warn('⚠️ Failed to refresh the page:', err.message);
}

// === Close browser and exit ===
await browser.close();
console.log('👋 Browser closed. Exiting...');
process.exit(0);


})();
