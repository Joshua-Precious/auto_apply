import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../cequre/utilities/config';
import { issueKey, scopes } from '../cequre/utilities/auth';

async function loadEnv() {
  for (const line of (await Bun.file('.env').text()).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0 && !line.startsWith('#')) process.env[line.slice(0, index)] ??= line.slice(index + 1);
  }
}
await loadEnv();

const [command, id] = process.argv.slice(2);
if (!['create', 'rotate', 'revoke'].includes(command || '')) {
  throw new Error('Usage: bun run keys create | rotate <key-id> | revoke <key-id>');
}
const config = loadConfig();
const { app } = await import('../cequre/app');
await app.init();

try {
  if (command === 'revoke') {
    if (!id) throw new Error('Key ID required');
    const key = (await app.find('api_keys', { where: { key_id: { eq: id } }, limit: 1, includeHidden: true })).docs[0];
    if (!key) throw new Error('Unknown key');
    await app.update('api_keys', key.id, { revoked_at: new Date().toISOString() });
    console.log(`Revoked key ${id}.`);
  } else {
    let clientId: string;
    let requested: string[] = [...scopes];
    let lifetimeDays = 30;
    if (command === 'rotate') {
      if (!id) throw new Error('Key ID required');
      const old = (await app.find('api_keys', {
        where: { key_id: { eq: id }, revoked_at: { exists: false } }, limit: 1, includeHidden: true,
      })).docs[0];
      if (!old || !Array.isArray(old.scopes) || old.scopes.some(scope => typeof scope !== 'string')) {
        throw new Error('Unknown active key');
      }
      clientId = old.client_id;
      requested = old.scopes as string[];
      lifetimeDays = Math.max(1, Math.min(90, Math.ceil((Date.parse(old.expires_at) - Date.now()) / 86_400_000)));
    } else {
      clientId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      await app.transaction(async trx => {
        await trx.create('tenants', { id: tenantId, name: 'Local integration', active: true });
        await trx.create('api_clients', {
          id: clientId,
          tenant_id: tenantId,
          name: 'Operator-provisioned client',
          active: true,
          scopes: requested as any,
          candidate_grants: [],
        });
      });
    }
    const key = await issueKey(app, config, clientId, requested, lifetimeDays);
    await mkdir('.local', { recursive: true, mode: 0o700 });
    const path = `.local/key-${key.id}.txt`;
    await writeFile(path, key.credential + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Issued key ${key.id}; client ${clientId}; expires ${key.expiresAt}. Secret saved once to ${path}; do not commit or share it.`);
    if (command === 'rotate') console.log('Old key remains active for controlled migration; revoke it explicitly after consumers switch.');
  }
} finally {
  app.retire();
  await app.adapter.disconnect();
}
