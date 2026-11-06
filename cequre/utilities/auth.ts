import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors';
import type { App } from './types';
import type { AppConfig } from './config';

// Scoped credentials are HMAC-SHA-256 digests under a deployment pepper. They
// are provisioned by an operator, not by public registration, and the digest is
// never returned by any route.

export const scopes = ['capabilities:read', 'jobs:analyze', 'matches:write', 'cv:tailor',
  'runs:write', 'runs:read', 'runs:control', 'artifacts:read', 'data:delete'] as const;
export type Scope = typeof scopes[number];

export interface Principal { keyId: string; clientId: string; tenantId: string; scopes: string[] }

export function digest(secret: string, pepper: string) {
  return createHmac('sha256', Buffer.from(pepper, 'hex')).update(secret).digest('hex');
}

export function parseKey(value: string | null) {
  const match = /^Bearer ja_live_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value || '');
  if (!match?.[1] || !match[2]) throw new ApiError(401, 'UNAUTHORIZED', 'A valid scoped API credential is required.');
  return { id: match[1], secret: match[2] };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return [];
  return value;
}

export async function authenticate(app: App, config: AppConfig, authorization: string | null): Promise<Principal> {
  const { id, secret } = parseKey(authorization);
  const key = (await app.find('api_keys', {
    where: { key_id: { eq: id }, pepper_version: { eq: config.pepperVersion } },
    limit: 1,
    includeHidden: true,
  })).docs[0];
  const expected = typeof key?.secret_digest === 'string' && /^[a-f0-9]{64}$/.test(key.secret_digest)
    ? key.secret_digest
    : '0'.repeat(64);
  const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest(secret, config.pepper), 'hex'));
  if (!key || !valid) throw new ApiError(401, 'UNAUTHORIZED', 'A valid scoped API credential is required.');
  if (key.revoked_at && Date.parse(key.revoked_at) <= Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid scoped API credential is required.');
  }
  if (!key.expires_at || Date.parse(key.expires_at) <= Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid scoped API credential is required.');
  }
  const client = await app.findById('api_clients', key.client_id);
  const tenant = await app.findById('tenants', key.tenant_id);
  if (!client?.active || !tenant?.active) throw new ApiError(401, 'UNAUTHORIZED', 'A valid scoped API credential is required.');
  const clientScopes = stringList(client.scopes);
  return {
    keyId: key.id,
    clientId: client.id,
    tenantId: tenant.id,
    scopes: stringList(key.scopes).filter(scope => clientScopes.includes(scope)),
  };
}

export function requireScope(principal: Principal, scope: Scope) {
  if (!principal.scopes.includes(scope)) {
    throw new ApiError(403, 'SCOPE_DENIED', 'This credential does not have the required permission.');
  }
}

export async function requireCandidateGrant(app: App, principal: Principal, subjectRef: string) {
  const client = await app.findById('api_clients', principal.clientId);
  const grants = stringList(client?.candidate_grants);
  if (!grants.includes(subjectRef)) {
    throw new ApiError(403, 'CANDIDATE_DENIED', 'This client is not granted access to the referenced candidate.', false,
      [{ path: 'candidate.subject_ref', code: 'NOT_GRANTED' }]);
  }
}

export async function issueKey(app: App, config: AppConfig, clientId: string, requested: string[], lifetimeDays = 30) {
  if (!requested.length || requested.some(scope => !scopes.includes(scope as Scope))
    || !Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 90) {
    throw new Error('Invalid key scopes or lifetime');
  }
  const client = await app.findById('api_clients', clientId);
  if (!client?.active) throw new Error('Client unavailable');
  const tenant = await app.findById('tenants', client.tenant_id);
  if (!tenant?.active) throw new Error('Tenant unavailable');
  const clientScopes = stringList(client.scopes);
  if (requested.some(scope => !clientScopes.includes(scope))) throw new Error('Key scopes must be a subset of client scopes');
  const id = crypto.randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetimeDays * 86_400_000).toISOString();
  await app.create('api_keys', {
    key_id: id, tenant_id: tenant.id, client_id: clientId,
    secret_digest: digest(secret, config.pepper), pepper_version: config.pepperVersion,
    scopes: requested, expires_at: expiresAt,
  });
  return { id, credential: `ja_live_${id}.${secret}`, expiresAt };
}
