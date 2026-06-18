// scheduler.js — kept alive by pm2, runs sehax.js every hour at :45
const { spawn } = require('child_process');
const path = require('path');

function msUntilNext45() {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0);
  next.setMilliseconds(0);
  if (now.getMinutes() >= 45) {
    next.setHours(now.getHours() + 1);
  }
  next.setMinutes(45);
  return next - now;
}

async function runSehax() {
  return new Promise(resolve => {
    console.log(`[${new Date().toISOString()}] ▶️  Starting sehax.js...`);
    const child = spawn(process.execPath, [path.join(__dirname, 'sehax.js')], {
      stdio: 'inherit',
      cwd: __dirname
    });
    child.on('exit', code => {
      console.log(`[${new Date().toISOString()}] ✅ sehax.js exited with code ${code}`);
      resolve();
    });
  });
}

(async () => {
  console.log(`[${new Date().toISOString()}] 🕐 Scheduler started`);
  while (true) {
    const wait = msUntilNext45();
    const mins = Math.round(wait / 60000);
    console.log(`[${new Date().toISOString()}] ⏳ Next run in ~${mins} minute(s)`);
    await new Promise(r => setTimeout(r, wait));
    await runSehax();
  }
})();
