import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_PREFIXES = ['sent:', 'digest:'];
const APP_EXACT_KEYS = new Set(['run:last', 'error:last']);

function main() {
  const repoRoot = resolve(import.meta.dirname, '..');
  const namespaceId = readNamespaceId(resolve(repoRoot, 'wrangler.jsonc'), 'MEDBOT_KV');
  const listedKeys = listAllKeys(namespaceId);
  const appKeys = listedKeys.filter(isAppKey);

  if (appKeys.length === 0) {
    console.log('No app-generated KV keys found.');
    return;
  }

  console.log(`Deleting ${appKeys.length} app-generated KV keys from ${namespaceId}...`);
  for (const key of appKeys) {
    deleteKey(namespaceId, key.name);
    console.log(`Deleted ${key.name}`);
  }

  console.log(`Deleted ${appKeys.length} app-generated KV keys.`);
}

function readNamespaceId(configPath, bindingName) {
  const config = readFileSync(configPath, 'utf8');
  const entryPattern = new RegExp(
    `"binding"\\s*:\\s*"${escapeRegExp(bindingName)}"[\\s\\S]*?"id"\\s*:\\s*"([^"]+)"`
  );
  const match = config.match(entryPattern);

  if (!match?.[1]) {
    throw new Error(`Could not find KV namespace ID for binding ${bindingName} in ${configPath}`);
  }

  return match[1];
}

function listAllKeys(namespaceId) {
  const keys = [];
  let cursor;

  while (true) {
    const args = ['wrangler', 'kv', 'key', 'list', '--remote', '--namespace-id', namespaceId];
    if (cursor) {
      args.push('--cursor', cursor);
    }

    const parsed = JSON.parse(runNpx(args));
    const pageKeys = Array.isArray(parsed) ? parsed : parsed.keys;
    if (!Array.isArray(pageKeys)) {
      throw new Error('Unexpected output from wrangler kv key list');
    }

    keys.push(...pageKeys);

    if (Array.isArray(parsed) || !parsed.cursor || parsed.list_complete) {
      return keys;
    }

    cursor = parsed.cursor;
  }
}

function isAppKey(key) {
  return APP_EXACT_KEYS.has(key.name) || APP_PREFIXES.some((prefix) => key.name.startsWith(prefix));
}

function deleteKey(namespaceId, keyName) {
  runNpx(['wrangler', 'kv', 'key', 'delete', '--remote', '--namespace-id', namespaceId, keyName]);
}

function runNpx(args) {
  return execFileSync('npx', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
