import { randomUUID } from 'node:crypto';
import { ApiError } from './errors';
import type { AppConfig } from './config';
import type { App } from './types';
import {
  hashPayload,
  revalidateStoredInput,
  type RunInput,
} from './contracts';
import {
  analyze,
  match,
  tailor,
  validateMatchAssessment,
  validateNormalizedJob,
  validateTailoredCv,
} from './intelligence';

const ACTIVE = ['queued', 'running'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
const USAGE = {
  model: null,
  prompt_version: 'deterministic-v1',
  input_tokens: null,
  output_tokens: null,
  estimated_cost_usd: 0,
  latency_ms: null,
} as const;

type AnyRecord = Record<string, any>;

function isoIn(ms: number) { return new Date(Date.now() + ms).toISOString(); }
function isExpired(value: string | null | undefined) {
  return Boolean(value && Date.parse(value) <= Date.now());
}

export interface AcceptedRun { runId: string; replay: boolean }

export async function createRun(
  app: App,
  config: AppConfig,
  principal: { tenantId: string; clientId: string },
  input: RunInput,
  idempotencyKey: string,
): Promise<AcceptedRun> {
  const recordKey = `${principal.tenantId}:${principal.clientId}:${idempotencyKey}`;
  const requestHash = hashPayload(input);
  const existing = (await app.find('idempotency_records', {
    where: { record_key: { eq: recordKey } }, limit: 1,
  })).docs[0];
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different payload.');
    }
    if (!isExpired(existing.expires_at)) return { runId: existing.run_id, replay: true };
    await app.delete('idempotency_records', existing.id);
  }

  const active = await app.count('runs', {
    where: { tenant_id: { eq: principal.tenantId }, status: { in: ACTIVE } },
  });
  if (active >= config.maxActiveIntelligence) {
    throw new ApiError(429, 'ACTIVE_LIMIT_REACHED', 'Too many active intelligence runs for this tenant.', true);
  }

  const ttl = config.retentionDays * 86_400_000;
  const runId = randomUUID();
  const now = new Date().toISOString();
  try {
    await app.transaction(async trx => {
      const job = await trx.create('job_snapshots', {
        tenant_id: principal.tenantId,
        input: input as any,
        content_hash: requestHash,
        expires_at: isoIn(ttl),
      });
      let candidateId: string | null = null;
      if (input.candidate) {
        const snapshot = await trx.create('candidate_snapshots', {
          tenant_id: principal.tenantId,
          subject_ref: input.candidate.subject_ref,
          snapshot: input.candidate as any,
          input_hash: hashPayload(input.candidate),
          consent_purpose: input.candidate.consent.purpose,
          consent_granted_at: input.candidate.consent.granted_at,
          expires_at: isoIn(ttl),
        });
        candidateId = snapshot.id;
      }
      await trx.create('runs', {
        id: runId,
        tenant_id: principal.tenantId,
        client_id: principal.clientId,
        candidate_snapshot_id: candidateId,
        candidate_subject_ref: input.candidate?.subject_ref ?? null,
        job_snapshot_id: job.id,
        operation: input.operation,
        status: 'queued',
        progress: 0,
        version: 1,
        event_sequence: 0,
        correlation_id: randomUUID(),
        deadline_at: isoIn(input.options.timeout_seconds * 1000),
        expires_at: isoIn(ttl),
      });
      await trx.create('idempotency_records', {
        tenant_id: principal.tenantId,
        client_id: principal.clientId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        run_id: runId,
        record_key: recordKey,
        expires_at: isoIn(config.idempotencyTtlHours * 3_600_000),
      });
      await appendEvent(trx as unknown as App, principal.tenantId, runId, 'run.queued', 'queued', { operation: input.operation });
    });
  } catch (error) {
    // A concurrent request with the same key may have won the unique index.
    const raced = (await app.find('idempotency_records', {
      where: { record_key: { eq: recordKey } }, limit: 1,
    })).docs[0];
    if (raced) {
      if (raced.request_hash !== requestHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different payload.');
      }
      return { runId: raced.run_id, replay: true };
    }
    throw error;
  }
  void executeRun(app, runId).catch(error => {
    console.error(JSON.stringify({ level: 'error', message: 'run execution failed', run_id: runId, error: String(error) }));
  });
  return { runId, replay: false };
}

export async function appendEvent(
  app: App,
  tenantId: string,
  runId: string,
  type: string,
  status: string,
  metadata: Record<string, unknown> = {},
) {
  const run = await app.findById('runs', runId);
  if (!run || run.tenant_id !== tenantId) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
  const sequence = run.event_sequence + 1;
  await app.update('runs', runId, { event_sequence: sequence });
  await app.create('run_events', {
    tenant_id: tenantId,
    run_id: runId,
    sequence,
    event_key: `${runId}:${sequence}`,
    type,
    status,
    metadata: metadata as any,
  });
  return sequence;
}

export function publicRun(run: AnyRecord) {
  return {
    run_id: run.id,
    operation: run.operation,
    status: run.status,
    phase: run.status === 'queued' ? 'prepare' : run.status === 'running' ? 'execute' : 'finalize',
    progress: run.progress,
    version: run.version,
    created_at: run.createdAt,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    cancel_requested_at: run.cancel_requested_at ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
    usage: run.usage ?? USAGE,
    intervention: null,
  };
}

export async function findRun(app: App, tenantId: string, runId: string) {
  const run = await app.findById('runs', runId);
  if (!run || run.tenant_id !== tenantId) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
  if (isExpired(run.expires_at)) throw new ApiError(410, 'RUN_EXPIRED', 'This run is no longer retained.');
  return run;
}

const executing = new Set<string>();

export async function executeRun(app: App, runId: string) {
  if (executing.has(runId)) return;
  executing.add(runId);
  try { await executeRunInner(app, runId); }
  finally { executing.delete(runId); }
}

async function executeRunInner(app: App, runId: string) {
  const run = await app.findById('runs', runId);
  if (!run || run.status !== 'queued' || !run.job_snapshot_id) return;

  await app.update('runs', runId, {
    status: 'running', started_at: new Date().toISOString(), version: run.version + 1,
  });
  await appendEvent(app, run.tenant_id, runId, 'run.started', 'running', {});

  try {
    const jobSnapshot = await app.findById('job_snapshots', run.job_snapshot_id);
    if (!jobSnapshot) throw new Error('Stored job snapshot is missing');
    const input = revalidateStoredInput(jobSnapshot.input);
    const normalized = validateNormalizedJob(analyze(input.job.text), input.job.text);
    let result: AnyRecord;
    if (input.operation === 'job_analysis') {
      result = {
        kind: 'job_analysis', job: normalized,
        limitations: ['Requirements are extracted deterministically from the supplied text only.'],
      };
    } else {
      if (!input.candidate) throw new Error('Stored candidate is missing');
      const facts = input.candidate.facts;
      if (input.operation === 'match') {
        const assessment = validateMatchAssessment(
          match(normalized, facts), facts.map(fact => fact.id), normalized.requirements.map(item => item.id),
        );
        result = {
          kind: 'match', assessment,
          limitations: ['Assessments use only the supplied candidate facts.', 'No hiring outcome is predicted.'],
        };
      } else {
        const cv = validateTailoredCv(tailor(normalized, facts), facts);
        const prior = await app.count('artifacts', {
          where: { tenant_id: { eq: run.tenant_id }, subject_ref: { eq: input.candidate.subject_ref }, kind: { eq: 'tailored_cv' } },
        });
        const version = prior + 1;
        const artifact = await app.create('artifacts', {
          tenant_id: run.tenant_id,
          run_id: runId,
          subject_ref: input.candidate.subject_ref,
          kind: 'tailored_cv',
          version,
          content: cv as any,
          checksum: hashPayload(cv),
          expires_at: run.expires_at,
          version_key: `${run.tenant_id}:${input.candidate.subject_ref}:tailored_cv:${version}`,
        });
        result = {
          kind: 'cv_tailoring', artifact_id: artifact.id, version,
          limitations: ['Suggestions are unverified and require human review before submission.'],
        };
      }
    }

    const latest = await app.findById('runs', runId);
    if (!latest || latest.status !== 'running') return;
    if (latest.cancel_requested_at) {
      await app.update('runs', runId, {
        status: 'cancelled', completed_at: new Date().toISOString(), version: latest.version + 1,
      });
      await appendEvent(app, run.tenant_id, runId, 'run.cancelled', 'cancelled', {});
      return;
    }
    await app.update('runs', runId, {
      status: 'completed', progress: 100, result: result as any, usage: USAGE as any,
      completed_at: new Date().toISOString(), version: latest.version + 1,
    });
    await appendEvent(app, run.tenant_id, runId, 'run.completed', 'completed', {});
  } catch (error) {
    const latest = await app.findById('runs', runId);
    if (!latest) return;
    const safe = error instanceof ApiError
      ? { code: error.code, message: error.message }
      : { code: 'EXECUTION_FAILED', message: 'The run could not be completed.' };
    await app.update('runs', runId, {
      status: 'failed', error: safe as any, completed_at: new Date().toISOString(), version: latest.version + 1,
    });
    await appendEvent(app, run.tenant_id, runId, 'run.failed', 'failed', { code: safe.code });
    console.error(JSON.stringify({ level: 'error', message: 'run failed', run_id: runId, code: safe.code }));
  }
}

export async function listEvents(app: App, tenantId: string, runId: string, afterSequence: number) {
  await findRun(app, tenantId, runId);
  const events = (await app.find('run_events', {
    where: { run_id: { eq: runId }, sequence: { gt: afterSequence } },
    sort: 'sequence', limit: 100,
  })).docs;
  return {
    events: events.map(event => ({
      sequence: event.sequence,
      type: event.type,
      status: event.status,
      metadata: event.metadata,
      created_at: event.createdAt,
    })),
    next_after_sequence: events.length ? events[events.length - 1]!.sequence : afterSequence,
  };
}

export async function cancelRun(app: App, tenantId: string, runId: string, expectedVersion: number) {
  const run = await findRun(app, tenantId, runId);
  if (TERMINAL.includes(run.status)) throw new ApiError(409, 'RUN_TERMINAL', 'This run has already reached a terminal state.');
  if (run.version !== expectedVersion) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'The run changed since it was read.', false,
      [{ path: 'expected_version', code: 'STALE' }]);
  }
  const now = new Date().toISOString();
  if (run.status === 'queued') {
    await app.update('runs', runId, {
      status: 'cancelled', cancel_requested_at: now, completed_at: now, version: run.version + 1,
    });
    await appendEvent(app, tenantId, runId, 'run.cancelled', 'cancelled', {});
    return { cancelled: true, effective: 'immediate' as const };
  }
  await app.update('runs', runId, { cancel_requested_at: now, version: run.version + 1 });
  await appendEvent(app, tenantId, runId, 'run.cancel_requested', 'running', {});
  return { cancelled: true, effective: 'at_safe_boundary' as const };
}

export async function createDeletion(app: App, principal: { tenantId: string; clientId: string }, subjectRef: string) {
  const existing = (await app.find('deletions', {
    where: { tenant_id: { eq: principal.tenantId }, subject_ref: { eq: subjectRef }, status: { in: ['queued', 'running'] } },
    sort: '-createdAt', limit: 1,
  })).docs[0];
  if (existing) {
    void purgeCandidate(app, existing.id).catch(error => {
      console.error(JSON.stringify({ level: 'error', message: 'deletion failed', deletion_id: existing.id, error: String(error) }));
    });
    return { deletionId: existing.id, replay: true };
  }
  const deletion = await app.create('deletions', {
    tenant_id: principal.tenantId,
    client_id: principal.clientId,
    subject_ref: subjectRef,
    status: 'queued',
    removed: {},
  });
  void purgeCandidate(app, deletion.id).catch(error => {
    console.error(JSON.stringify({ level: 'error', message: 'deletion failed', deletion_id: deletion.id, error: String(error) }));
  });
  return { deletionId: deletion.id, replay: false };
}

export async function purgeCandidate(app: App, deletionId: string) {
  const deletion = await app.findById('deletions', deletionId);
  if (!deletion || deletion.status !== 'queued') return;
  await app.update('deletions', deletionId, { status: 'running' });
  try {
    const runs = (await app.find('runs', {
      where: { tenant_id: { eq: deletion.tenant_id }, candidate_subject_ref: { eq: deletion.subject_ref } },
      limit: 500,
    })).docs;
    let cancelled = 0;
    for (const run of runs) {
      if (ACTIVE.includes(run.status)) {
        await app.update('runs', run.id, {
          status: 'cancelled', cancel_requested_at: new Date().toISOString(),
          completed_at: new Date().toISOString(), version: run.version + 1,
        });
        await appendEvent(app, deletion.tenant_id, run.id, 'run.cancelled', 'cancelled', { reason: 'candidate_deletion' });
        cancelled += 1;
      }
    }
    const artifacts = (await app.find('artifacts', {
      where: { tenant_id: { eq: deletion.tenant_id }, subject_ref: { eq: deletion.subject_ref } }, limit: 500,
    })).docs;
    for (const artifact of artifacts) await removeIfPresent(app, 'artifacts', artifact.id);
    const snapshots = (await app.find('candidate_snapshots', {
      where: { tenant_id: { eq: deletion.tenant_id }, subject_ref: { eq: deletion.subject_ref } }, limit: 500,
    })).docs;
    for (const snapshot of snapshots) await removeIfPresent(app, 'candidate_snapshots', snapshot.id);
    for (const run of runs) {
      if (run.job_snapshot_id) await removeIfPresent(app, 'job_snapshots', run.job_snapshot_id);
      await app.update('runs', run.id, {
        result: null, error: null, candidate_snapshot_id: null,
        candidate_subject_ref: null, job_snapshot_id: null,
      });
    }
    await app.update('deletions', deletionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      removed: { runs_cancelled: cancelled, artifacts: artifacts.length, snapshots: snapshots.length } as any,
    });
  } catch (error) {
    await app.update('deletions', deletionId, {
      status: 'failed', error: { code: 'DELETION_FAILED', message: 'Candidate deletion did not complete.' } as any,
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function removeIfPresent(app: App, collection: 'artifacts' | 'candidate_snapshots' | 'job_snapshots', id: string) {
  try { await app.delete(collection, id); }
  catch (error) {
    if (!/not found/i.test(String(error))) throw error;
  }
}

export async function purgeExpired(app: App, config: AppConfig) {
  const now = new Date().toISOString();
  const removed = { artifacts: 0, job_snapshots: 0, candidate_snapshots: 0, idempotency_records: 0, runs_redacted: 0 };
  const artifacts = (await app.find('artifacts', { where: { expires_at: { lt: now } }, limit: 500 })).docs;
  for (const artifact of artifacts) { await app.delete('artifacts', artifact.id); removed.artifacts += 1; }
  const candidates = (await app.find('candidate_snapshots', { where: { expires_at: { lt: now } }, limit: 500 })).docs;
  for (const snapshot of candidates) {
    if (await app.count('runs', { where: { candidate_snapshot_id: { eq: snapshot.id } } }) === 0) {
      await app.delete('candidate_snapshots', snapshot.id); removed.candidate_snapshots += 1;
    }
  }
  const jobs = (await app.find('job_snapshots', { where: { expires_at: { lt: now } }, limit: 500 })).docs;
  for (const job of jobs) {
    if (await app.count('runs', { where: { job_snapshot_id: { eq: job.id } } }) === 0) {
      await app.delete('job_snapshots', job.id); removed.job_snapshots += 1;
    }
  }
  const records = (await app.find('idempotency_records', { where: { expires_at: { lt: now } }, limit: 500 })).docs;
  for (const record of records) { await app.delete('idempotency_records', record.id); removed.idempotency_records += 1; }
  const runs = (await app.find('runs', { where: { expires_at: { lt: now } }, limit: 500 })).docs;
  for (const run of runs) {
    if (run.result === null && run.error === null && run.candidate_subject_ref === null) continue;
    await app.update('runs', run.id, {
      result: null, error: null, candidate_snapshot_id: null,
      candidate_subject_ref: null, job_snapshot_id: null,
    });
    removed.runs_redacted += 1;
  }
  console.log(JSON.stringify({ level: 'info', message: 'retention purge complete', retention_days: config.retentionDays, ...removed }));
  return removed;
}

export async function processQueuedRuns(app: App, limit = 10) {
  const queued = (await app.find('runs', {
    where: { status: { eq: 'queued' } }, sort: 'createdAt', limit,
  })).docs;
  for (const run of queued) {
    try { await executeRun(app, run.id); }
    catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'queued run recovery failed', run_id: run.id, error: String(error) }));
    }
  }
  return queued.length;
}
