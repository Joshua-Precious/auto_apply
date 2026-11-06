import { CequreModule, t } from 'cequre-ts';
import openapi from '../../docs/openapi.json';
import type { Collections } from '../_generated/server';
import { ApiError } from '../utilities/errors';
import { loadConfig } from '../utilities/config';
import {
  authenticate,
  requireCandidateGrant,
  requireScope,
  scopes as allScopes,
  type Principal,
  type Scope,
} from '../utilities/auth';
import {
  parseAnalyzeRequest,
  parseCreateRunRequest,
  parseIdempotencyKey,
  parseMatchRequest,
  parseTailorRequest,
  limits,
  refPattern,
  type Candidate,
  type RunInput,
} from '../utilities/contracts';
import {
  cancelRun,
  createDeletion,
  createRun,
  findRun,
  listEvents,
  processQueuedRuns,
  publicRun,
  purgeExpired,
} from '../utilities/runs';
import type { App } from '../utilities/types';

export const routesModule = new CequreModule<Collections>();

function requestId() { return crypto.randomUUID(); }

function send(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const id = requestId();
  return new Response(JSON.stringify({ data, request_id: id }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-request-id': id,
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function failure(error: unknown) {
  const id = requestId();
  const payload = error instanceof ApiError
    ? {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
      }
    : (() => {
        console.error(JSON.stringify({
          level: 'error',
          message: 'unhandled route error',
          request_id: id,
          error: error instanceof Error ? error.message : String(error),
        }));
        return {
          error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: true, details: [] },
        };
      })();
  const status = error instanceof ApiError ? error.status : 500;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-request-id': id,
    'x-content-type-options': 'nosniff',
  };
  if (status === 429) headers['retry-after'] = '60';
  return new Response(JSON.stringify({ ...payload, request_id: id }), { status, headers });
}

type Handler = (ctx: any) => Promise<Response> | Response;
function handle(fn: Handler) {
  return async (ctx: any) => {
    try { return await fn(ctx); } catch (error) { return failure(error); }
  };
}

function bodyOf(ctx: any): unknown {
  if (typeof ctx.body !== 'string') return ctx.body ?? {};
  try { return JSON.parse(ctx.body); } catch { return ctx.body; }
}

async function principalFor(ctx: any, scope: Scope): Promise<Principal> {
  const principal = await authenticate(ctx.cequre as App, loadConfig(), ctx.request.headers.get('authorization'));
  requireScope(principal, scope);
  return principal;
}

function capabilities() {
  return {
    api_version: 'v1',
    backend: 'cequre',
    operations: [
      { operation: 'job_analysis', status: 'available' },
      { operation: 'match', status: 'available' },
      { operation: 'cv_tailoring', status: 'available' },
      { operation: 'application_prepare', status: 'unavailable' },
    ],
    limits: {
      job_characters: [limits.jobMinCharacters, limits.jobMaxCharacters],
      candidate_facts: limits.maxFacts,
      timeout_seconds: [limits.minTimeoutSeconds, limits.maxTimeoutSeconds],
      request_bytes: limits.maxBodyBytes,
    },
    consent_purposes: ['job_matching', 'cv_tailoring'],
    disclosure: 'Cequre-backed deterministic intelligence. No hiring outcomes are predicted or submitted.',
  };
}

async function acceptRun(ctx: any, input: RunInput, scope: Scope) {
  const principal = await principalFor(ctx, scope);
  if (input.candidate) await requireCandidateGrant(ctx.cequre as App, principal, input.candidate.subject_ref);
  const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
  const accepted = await createRun(ctx.cequre as App, loadConfig(), principal, input, key);
  return send({
    run_id: accepted.runId,
    status: 'accepted',
    replayed: accepted.replay,
    status_url: `/v1/runs/${accepted.runId}`,
  }, 202, { location: `/v1/runs/${accepted.runId}` });
}

routesModule.get('/openapi.json', () => new Response(JSON.stringify(openapi), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
}));

routesModule.get('/health', handle(async ctx => {
  const tenants = await (ctx.cequre as App).count('tenants');
  return send({ status: 'ok', service: 'jobauto-v1', backend: 'cequre', tenants });
}));

routesModule.get('/capabilities', handle(async ctx => {
  await principalFor(ctx, 'capabilities:read');
  return send(capabilities());
}));

routesModule.post('/jobs/analyze', { body: t.Any() }, handle(async ctx =>
  acceptRun(ctx, parseAnalyzeRequest(bodyOf(ctx)), 'jobs:analyze')));

routesModule.post('/matches', { body: t.Any() }, handle(async ctx =>
  acceptRun(ctx, parseMatchRequest(bodyOf(ctx)), 'matches:write')));

routesModule.post('/cv/tailor', { body: t.Any() }, handle(async ctx =>
  acceptRun(ctx, parseTailorRequest(bodyOf(ctx)), 'cv:tailor')));

routesModule.post('/runs', { body: t.Any() }, handle(async ctx =>
  acceptRun(ctx, parseCreateRunRequest(bodyOf(ctx)), 'runs:write')));

routesModule.get('/runs/:run_id', { params: t.Object({ run_id: t.String() }) }, handle(async ctx => {
  const principal = await principalFor(ctx, 'runs:read');
  const run = await findRun(ctx.cequre as App, principal.tenantId, ctx.params.run_id);
  return send(publicRun(run));
}));

routesModule.get('/runs/:run_id/events', {
  params: t.Object({ run_id: t.String() }),
  query: t.Object({ after_sequence: t.Optional(t.String()) }),
}, handle(async ctx => {
  const principal = await principalFor(ctx, 'runs:read');
  const raw = Number(ctx.query?.after_sequence ?? 0);
  if (!Number.isInteger(raw) || raw < 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'after_sequence must be a non-negative integer.', false,
      [{ path: 'after_sequence', code: 'INVALID' }]);
  }
  return send(await listEvents(ctx.cequre as App, principal.tenantId, ctx.params.run_id, raw));
}));

routesModule.post('/runs/:run_id/cancel', {
  params: t.Object({ run_id: t.String() }),
  body: t.Any(),
}, handle(async ctx => {
  const principal = await principalFor(ctx, 'runs:control');
  const version = Number((bodyOf(ctx) as any)?.expected_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(400, 'INVALID_INPUT', 'expected_version must be a positive integer.', false,
      [{ path: 'expected_version', code: 'INVALID' }]);
  }
  const result = await cancelRun(ctx.cequre as App, principal.tenantId, ctx.params.run_id, version);
  return send({ run_id: ctx.params.run_id, ...result });
}));

async function artifactFor(ctx: any, artifactId: string, tenantId: string) {
  const artifact = await (ctx.cequre as App).findById('artifacts', artifactId);
  if (!artifact || artifact.tenant_id !== tenantId || Date.parse(artifact.expires_at) <= Date.now()) {
    throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
  }
  return {
    artifact_id: artifact.id,
    kind: artifact.kind,
    subject_ref: artifact.subject_ref,
    version: artifact.version,
    checksum: artifact.checksum,
    content: artifact.content,
    created_at: artifact.createdAt,
  };
}

routesModule.get('/artifacts/:artifact_id', {
  params: t.Object({ artifact_id: t.String() }),
}, handle(async ctx => {
  const principal = await principalFor(ctx, 'artifacts:read');
  return send(await artifactFor(ctx, ctx.params.artifact_id, principal.tenantId));
}));

routesModule.delete('/candidates/:subject_ref/data', handle(async ctx => {
  const principal = await principalFor(ctx, 'data:delete');
  const subjectRef = ctx.params.subject_ref;
  if (!refPattern.test(subjectRef) || subjectRef.length > 128) {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid candidate reference.', false,
      [{ path: 'subject_ref', code: 'INVALID' }]);
  }
  await requireCandidateGrant(ctx.cequre as App, principal, subjectRef);
  const deletion = await createDeletion(ctx.cequre as App, principal, subjectRef);
  return send({
    deletion_id: deletion.deletionId,
    status: deletion.replay ? 'in_progress' : 'accepted',
    replayed: deletion.replay,
    status_url: `/v1/deletions/${deletion.deletionId}`,
  }, 202);
}));

routesModule.get('/deletions/:deletion_id', {
  params: t.Object({ deletion_id: t.String() }),
}, handle(async ctx => {
  const principal = await principalFor(ctx, 'runs:read');
  const deletion = await (ctx.cequre as App).findById('deletions', ctx.params.deletion_id);
  if (!deletion || deletion.tenant_id !== principal.tenantId) {
    throw new ApiError(404, 'DELETION_NOT_FOUND', 'Deletion not found.');
  }
  return send({
    deletion_id: deletion.id,
    subject_ref: deletion.subject_ref,
    status: deletion.status,
    removed: deletion.removed,
    error: deletion.error ?? null,
    completed_at: deletion.completed_at ?? null,
    created_at: deletion.createdAt,
  }, deletion.status === 'completed' || deletion.status === 'failed' ? 200 : 202);
}));

// ---------------------------------------------------------------------------
// Loopback-only workbench demo. No key ever reaches the browser: the server
// uses a dedicated least-privilege key identified by DEMO_KEY_ID.
// ---------------------------------------------------------------------------

const demoFacts = [
  { id: 'demo-fact-1', kind: 'summary' as const, text: 'Backend engineer focused on TypeScript services and API reliability.' },
  { id: 'demo-fact-2', kind: 'skill' as const, text: 'TypeScript' },
  { id: 'demo-fact-3', kind: 'experience' as const, text: 'Built API endpoints and automated tests at Example Ltd.', employer: 'Example Ltd', title: 'Software Engineer', start_date: '2021-03-01' },
  { id: 'demo-fact-4', kind: 'skill' as const, text: 'PostgreSQL' },
];

function demoCandidate(purpose: 'job_matching' | 'cv_tailoring'): Candidate {
  return {
    subject_ref: 'demo-candidate-1',
    consent: { purpose, granted_at: new Date().toISOString() },
    facts: demoFacts,
    preferences: { preparation_only: true },
  };
}

function demoEnabled() {
  return process.env.ENABLE_LOCAL_DEMO === 'true' && process.env.NODE_ENV !== 'production';
}

function requireDemo(ctx: any) {
  if (!demoEnabled()) throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
  if (ctx.request.headers.get('x-jobauto-demo') !== 'true') {
    throw new ApiError(403, 'ORIGIN_DENIED', 'Local demo requires the workbench demo header.');
  }
  const origin = ctx.request.headers.get('origin');
  const expected = process.env.APP_ORIGIN;
  if (origin && expected) {
    try {
      if (new URL(origin).origin !== new URL(expected).origin) {
        throw new ApiError(403, 'ORIGIN_DENIED', 'Local demo requires the configured workbench origin.');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(403, 'ORIGIN_DENIED', 'Local demo requires the configured workbench origin.');
    }
  }
}

async function demoPrincipal(ctx: any, scope: Scope | null): Promise<Principal> {
  requireDemo(ctx);
  const keyId = process.env.DEMO_KEY_ID;
  if (!keyId) throw new ApiError(503, 'DEMO_NOT_CONFIGURED', 'Local demo client is not configured.');
  const config = loadConfig();
  const key = (await (ctx.cequre as App).find('api_keys', {
    where: { key_id: { eq: keyId }, pepper_version: { eq: config.pepperVersion } },
    limit: 1, includeHidden: true,
  })).docs[0];
  if (!key || (key.revoked_at && Date.parse(key.revoked_at) <= Date.now()) || Date.parse(key.expires_at) <= Date.now()) {
    throw new ApiError(401, 'DEMO_REVOKED', 'Local demo credential is unavailable.');
  }
  const client = await (ctx.cequre as App).findById('api_clients', key.client_id);
  const tenant = await (ctx.cequre as App).findById('tenants', key.tenant_id);
  if (!client?.active || !tenant?.active) throw new ApiError(401, 'DEMO_REVOKED', 'Local demo credential is unavailable.');
  const grant = {
    keyId: key.id,
    clientId: client.id,
    tenantId: tenant.id,
    scopes: Array.isArray(key.scopes) ? key.scopes.filter((entry): entry is string => typeof entry === 'string') : [],
  };
  if (scope) requireScope(grant, scope);
  return grant;
}

const demoScenarios = [
  { scenario: 'job_analysis', endpoint: 'POST /v1/jobs/analyze', input: 'Caller-supplied job text.' },
  { scenario: 'match', endpoint: 'POST /v1/matches', input: 'Caller-supplied job text.', candidate: 'Fixed synthetic demo candidate.' },
  { scenario: 'cv_tailoring', endpoint: 'POST /v1/cv/tailor', input: 'Caller-supplied job text.', candidate: 'Fixed synthetic demo candidate.' },
];

routesModule.get('/demo/capabilities', handle(async ctx => {
  await demoPrincipal(ctx, 'capabilities:read');
  return send(capabilities());
}));

routesModule.get('/demo/scenarios', handle(async ctx => {
  await demoPrincipal(ctx, 'capabilities:read');
  return send({ scenarios: demoScenarios });
}));

routesModule.post('/demo/runs', { body: t.Any() }, handle(async ctx => {
  const record = (bodyOf(ctx) ?? {}) as Record<string, unknown>;
  const scenario = record.scenario;
  if (scenario !== 'job_analysis' && scenario !== 'match' && scenario !== 'cv_tailoring') {
    throw new ApiError(400, 'INVALID_INPUT', 'The demo scenario must be job_analysis, match or cv_tailoring.', false,
      [{ path: 'scenario', code: 'UNSUPPORTED_SCENARIO' }]);
  }
  if (typeof record.job_text !== 'string') {
    throw new ApiError(400, 'INVALID_INPUT', 'The demo job text must be a string.', false,
      [{ path: 'job_text', code: 'EXPECTED_STRING' }]);
  }
  const scope: Scope = scenario === 'match' ? 'matches:write' : scenario === 'cv_tailoring' ? 'cv:tailor' : 'jobs:analyze';
  const principal = await demoPrincipal(ctx, scope);
  const job = { kind: 'text' as const, text: record.job_text };
  const options = { locale: 'en' as const, timeout_seconds: 300 };
  const input = scenario === 'match'
    ? parseMatchRequest({ candidate: demoCandidate('job_matching'), job, options })
    : scenario === 'cv_tailoring'
      ? parseTailorRequest({ candidate: demoCandidate('cv_tailoring'), job, options })
      : parseAnalyzeRequest({ job, options });
  const run = await createRun(ctx.cequre as App, loadConfig(), principal, input, `demo-${crypto.randomUUID()}`);
  return send({
    run_id: run.runId,
    status: 'queued',
    status_url: `/v1/demo/runs/${run.runId}`,
    created_at: new Date().toISOString(),
  }, 202, { location: `/v1/demo/runs/${run.runId}` });
}));

routesModule.get('/demo/runs/:run_id', {
  params: t.Object({ run_id: t.String() }),
}, handle(async ctx => {
  const principal = await demoPrincipal(ctx, 'runs:read');
  return send(publicRun(await findRun(ctx.cequre as App, principal.tenantId, ctx.params.run_id)));
}));

routesModule.get('/demo/runs/:run_id/events', {
  params: t.Object({ run_id: t.String() }),
  query: t.Object({ after_sequence: t.Optional(t.String()) }),
}, handle(async ctx => {
  const principal = await demoPrincipal(ctx, 'runs:read');
  const raw = Number(ctx.query?.after_sequence ?? 0);
  return send(await listEvents(ctx.cequre as App, principal.tenantId, ctx.params.run_id,
    Number.isInteger(raw) && raw > 0 ? raw : 0));
}));

routesModule.get('/demo/artifacts/:artifact_id', {
  params: t.Object({ artifact_id: t.String() }),
}, handle(async ctx => {
  const principal = await demoPrincipal(ctx, 'artifacts:read');
  return send(await artifactFor(ctx, ctx.params.artifact_id, principal.tenantId));
}));

// In-process durable recovery and retention. Cequre's cron provider triggers
// this every minute; no separate worker process is required.
routesModule.cron('jobauto-maintenance', '*/1 * * * *', async runtime => {
  const app = runtime as unknown as App;
  await processQueuedRuns(app);
  await purgeExpired(app, loadConfig());
});

// Keep the exported scope list referenced so generated clients and tests can
// assert the exact permission surface without importing auth internals.
export { allScopes };
