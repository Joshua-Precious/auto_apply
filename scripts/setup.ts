import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';

async function ensureEnvFile() {
  try { await access('.env'); return; } catch {}
  const data = [
    'DATABASE_URL=postgres://jobauto:local-development-only@127.0.0.1:55432/jobauto',
    'API_KEY_PEPPER=' + randomBytes(32).toString('hex'),
    'API_KEY_PEPPER_VERSION=1',
    'APP_ORIGIN=http://127.0.0.1:5175',
    'HOST=127.0.0.1',
    'SERVICE_PORT=4310',
    'ENABLE_LOCAL_DEMO=false',
  ].join('\n') + '\n';
  await writeFile('.env', data, { mode: 0o600, flag: 'wx' });
}

async function loadEnv() {
  for (const line of (await Bun.file('.env').text()).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0 && !line.startsWith('#')) process.env[line.slice(0, index)] ??= line.slice(index + 1);
  }
}

await ensureEnvFile();
await loadEnv();

// Cequre owns the schema. The generated DSL is the source of truth; there are
// no hand-written migrations to replay.
const sync = Bun.spawnSync({
  cmd: ['cequre', 'db:sync', '--dir', './cequre'],
  env: process.env,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (sync.exitCode !== 0) throw new Error('cequre db:sync failed');

await mkdir('.local', { recursive: true, mode: 0o700 });
console.log('Cequre schema synced. No key issued; use bun run keys create.');
