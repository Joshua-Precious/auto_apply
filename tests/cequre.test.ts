import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { app } from '../cequre/app';
import { createCequreTest } from 'cequre-ts/testing';
import { issueKey, scopes } from '../cequre/utilities/auth';
import { loadConfig } from '../cequre/utilities/config';
import { claimQueuedRun, purgeExpired } from '../cequre/utilities/runs';

let harness: ReturnType<typeof createCequreTest>;
let headers: Record<string, string>;
let tenantId: string;
let clientId: string;

const jobText = 'Example Ltd seeks a Backend Engineer with TypeScript experience. You must have 3+ years with Node.js. PostgreSQL is preferred.';

function envelope<T = any>(body: any): T { return body.data as T; }

async function waitForRun(runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await app.findById('runs', runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await Bun.sleep(25);
  }
  throw new Error(`Run ${runId} did not finish`);
}

beforeAll(async () => {
  await app.init();
  const tenant = await app.create('tenants', { name: 'Cequre test tenant', active: true });
  tenantId = tenant.id;
  const client = await app.create('api_clients', {
    tenant_id: tenant.id,
    name: 'Cequre test client',
    active: true,
    scopes: [...scopes] as any,
    candidate_grants: ['test-candidate-1'] as any,
  });
  clientId = client.id;
  const key = await issueKey(app, loadConfig(), client.id, [...scopes], 30);
  headers = { Authorization: `Bearer ${key.credential}`, 'Content-Type': 'application/json' };
  harness = createCequreTest(app);
});

afterAll(async () => {
  app.retire();
  await app.adapter.disconnect();
});

describe('Cequre health and authentication', () => {
  it('serves health without credentials', async () => {
    const response = await harness.routes.get('/v1/health');
    expect(response.status).toBe(200);
    expect(envelope(await response.json()).backend).toBe('cequre');
  });

  it('rejects an unauthenticated capability read', async () => {
    const response = await harness.routes.get('/v1/capabilities');
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('returns capabilities for a scoped key', async () => {
    const response = await harness.routes.get('/v1/capabilities', { headers });
    expect(response.status).toBe(200);
    const data = envelope(await response.json());
    expect(data.backend).toBe('cequre');
    expect(data.operations.find((item: any) => item.operation === 'application_prepare').status).toBe('unavailable');
  });
});

describe('durable execution claims', () => {
  it('allows exactly one claimant across replicas', async () => {
    const run = await app.create('runs', {
      tenant_id: tenantId,
      client_id: clientId,
      operation: 'job_analysis',
      status: 'queued',
      progress: 0,
      version: 1,
      event_sequence: 0,
      correlation_id: crypto.randomUUID(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    try {
      expect(await claimQueuedRun(app, run.id)).toBe(true);
      expect(await claimQueuedRun(app, run.id)).toBe(false);
      const stored = await app.findById('runs', run.id);
      expect(stored?.status).toBe('running');
      expect(stored?.started_at).toBeTruthy();
    } finally {
      await app.delete('runs', run.id);
    }
  });
});

describe('Cequre run lifecycle', () => {
  it('accepts an analysis idempotently and completes it', async () => {
    const key = `analyze-${crypto.randomUUID()}`;
    const response = await harness.routes.post('/v1/jobs/analyze', {
      headers: { ...headers, 'Idempotency-Key': key },
      body: { job: { kind: 'text', text: jobText } },
    });
    expect(response.status).toBe(202);
    const accepted = envelope(await response.json());
    expect(accepted.run_id).toBeString();

    const replay = await harness.routes.post('/v1/jobs/analyze', {
      headers: { ...headers, 'Idempotency-Key': key },
      body: { job: { kind: 'text', text: jobText } },
    });
    expect(replay.status).toBe(202);
    expect(envelope(await replay.json()).run_id).toBe(accepted.run_id);

    const conflict = await harness.routes.post('/v1/jobs/analyze', {
      headers: { ...headers, 'Idempotency-Key': key },
      body: { job: { kind: 'text', text: `${jobText} Python is required.` } },
    });
    expect(conflict.status).toBe(409);

    const run = await waitForRun(accepted.run_id);
    expect(run.status).toBe('completed');
    const result = run.result as any;
    expect(result.job.requirements.length).toBeGreaterThan(0);
    for (const requirement of result.job.requirements) {
      expect(jobText.includes(requirement.source_quote)).toBe(true);
    }

    const events = await harness.routes.get(`/v1/runs/${accepted.run_id}/events`, { headers });
    expect(events.status).toBe(200);
    const history = envelope(await events.json());
    expect(history.events.map((event: any) => event.type)).toContain('run.completed');
  });

  it('creates a grounded immutable tailoring artifact', async () => {
    const response = await harness.routes.post('/v1/cv/tailor', {
      headers: { ...headers, 'Idempotency-Key': `tailor-${crypto.randomUUID()}` },
      body: {
        job: { kind: 'text', text: jobText },
        options: { locale: 'en', timeout_seconds: 30 },
        candidate: {
          subject_ref: 'test-candidate-1',
          consent: { purpose: 'cv_tailoring', granted_at: new Date().toISOString() },
          facts: [
            { id: 'fact-1', kind: 'skill', text: 'TypeScript' },
            { id: 'fact-2', kind: 'experience', text: 'Built API endpoints and automated tests.', employer: 'Example Ltd', title: 'Software Engineer', start_date: '2021-03-01' },
          ],
          preferences: { preparation_only: true },
        },
      },
    });
    expect(response.status).toBe(202);
    const accepted = envelope(await response.json());
    const run = await waitForRun(accepted.run_id);
    expect(run.status).toBe('completed');
    const tailored = run.result as any;
    expect(tailored.artifact_id).toBeString();

    const artifact = await harness.routes.get(`/v1/artifacts/${tailored.artifact_id}`, { headers });
    expect(artifact.status).toBe(200);
    const data = envelope(await artifact.json());
    expect(data.kind).toBe('tailored_cv');
    expect(data.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(data.content.sections.length).toBeGreaterThan(0);
  });

  it('cancels a queued run with a version check', async () => {
    const run = await app.create('runs', {
      tenant_id: tenantId,
      client_id: clientId,
      job_snapshot_id: null,
      candidate_snapshot_id: null,
      candidate_subject_ref: null,
      operation: 'job_analysis',
      status: 'queued',
      progress: 0,
      version: 1,
      event_sequence: 0,
      correlation_id: crypto.randomUUID(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const response = await harness.routes.post(`/v1/runs/${run.id}/cancel`, {
      headers,
      body: { expected_version: 1 },
    });
    expect(response.status).toBe(200);
    expect(envelope(await response.json()).effective).toBe('immediate');
    expect((await app.findById('runs', run.id))?.status).toBe('cancelled');
  });
});

describe('Cequre deletion and retention', () => {
  it('erases candidate data and artifacts', async () => {
    const run = (await app.find('runs', {
      where: { tenant_id: { eq: tenantId }, candidate_subject_ref: { eq: 'test-candidate-1' } }, limit: 1,
    })).docs[0];
    expect(run).toBeDefined();
    const artifactId = (run!.result as any)?.artifact_id as string;

    const response = await harness.routes.delete('/v1/candidates/test-candidate-1/data', { headers });
    expect(response.status).toBe(202);
    const deletionId = envelope(await response.json()).deletion_id;

    let deletion: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      deletion = await app.findById('deletions', deletionId);
      if (deletion?.status === 'completed') break;
      await Bun.sleep(25);
    }
    expect(deletion.status).toBe('completed');
    expect(deletion.removed.artifacts).toBeGreaterThan(0);
    expect(await app.findById('artifacts', artifactId)).toBeNull();
    expect((await app.findById('runs', run!.id))?.result).toBeNull();
  });

  it('sweeps expired artifacts and idempotency records', async () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const artifact = await app.create('artifacts', {
      tenant_id: tenantId,
      run_id: 'retention-run',
      subject_ref: 'retention-subject',
      kind: 'tailored_cv',
      version: 1,
      content: {},
      checksum: '0'.repeat(64),
      expires_at: expired,
      version_key: `retention-${crypto.randomUUID()}`,
    });
    const record = await app.create('idempotency_records', {
      tenant_id: tenantId,
      client_id: clientId,
      idempotency_key: 'retention-key',
      request_hash: '0'.repeat(64),
      run_id: 'retention-run',
      record_key: `retention-${crypto.randomUUID()}`,
      expires_at: expired,
    });
    const removed = await purgeExpired(app, loadConfig());
    expect(removed.artifacts).toBeGreaterThan(0);
    expect(removed.idempotency_records).toBeGreaterThan(0);
    expect(await app.findById('artifacts', artifact.id)).toBeNull();
    expect(await app.findById('idempotency_records', record.id)).toBeNull();
  });
});
