import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../cequre/utilities/config';
import { issueKey } from '../cequre/utilities/auth';

async function loadEnv() {
  for (const line of (await Bun.file('.env').text()).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0 && !line.startsWith('#')) process.env[line.slice(0, index)] ??= line.slice(index + 1);
  }
}
await loadEnv();

const config = loadConfig();
const origin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:5175');
if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) {
  throw new Error('Demo is loopback-development only');
}

const demoScopes = ['capabilities:read', 'jobs:analyze', 'matches:write', 'cv:tailor', 'runs:read', 'artifacts:read'];
const tenantId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const { app } = await import('../cequre/app');
await app.init();

try {
  await app.transaction(async trx => {
    await trx.create('tenants', { id: tenantId, name: 'Synthetic local demo', active: true });
    await trx.create('api_clients', {
      id: clientId,
      tenant_id: tenantId,
      name: 'Fixed loopback demo',
      active: true,
      scopes: demoScopes as any,
      candidate_grants: ['demo-candidate-1'] as any,
    });
  });
  const key = await issueKey(app, config, clientId, demoScopes, 7);
  const current = await Bun.file('.env').text();
  const lines = current.split('\n').filter(line => !line.startsWith('ENABLE_LOCAL_DEMO=') && !line.startsWith('DEMO_KEY_ID='));
  await writeFile('.env', lines.join('\n').trimEnd() + `\nENABLE_LOCAL_DEMO=true\nDEMO_KEY_ID=${key.id}\n`, { mode: 0o600 });
  console.log('Loopback demo enabled (capabilities, job analysis, synthetic match/tailoring). Restart the API.');
} finally {
  app.retire();
  await app.adapter.disconnect();
}
