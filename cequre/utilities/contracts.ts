import { createHash } from 'node:crypto';
import { ApiError, type FieldDetail } from './errors';

// Public request contract. Unknown properties are rejected; every accepted
// payload is normalized into the exact object that is hashed for idempotency,
// persisted as a snapshot, and later re-validated by the run engine.

export const operations = ['job_analysis', 'match', 'cv_tailoring', 'application_prepare'] as const;
export type Operation = typeof operations[number];
export const factKinds = ['summary', 'skill', 'experience', 'education', 'certification', 'project', 'achievement'] as const;
export type FactKind = typeof factKinds[number];
export const consentPurposes = ['job_matching', 'cv_tailoring', 'application_preparation'] as const;
export type ConsentPurpose = typeof consentPurposes[number];

export interface JobInput { kind: 'text'; text: string }
export interface CandidateFact {
  id: string; kind: FactKind; text: string;
  employer?: string; title?: string; institution?: string; credential?: string;
  start_date?: string; end_date?: string | null;
}
export interface Candidate {
  subject_ref: string; consent: { purpose: ConsentPurpose; granted_at: string };
  facts: CandidateFact[]; preferences: { preparation_only: boolean };
}
export interface Options { locale: 'en'; timeout_seconds: number }
export interface RunInput { operation: Operation; job: JobInput; candidate?: Candidate; options: Options }

export const limits = {
  jobMinCharacters: 20, jobMaxCharacters: 30000, maxFacts: 200, maxBodyBytes: 262144,
  minTimeoutSeconds: 30, maxTimeoutSeconds: 300,
} as const;

const factFields = ['id', 'kind', 'text', 'employer', 'title', 'institution', 'credential', 'start_date', 'end_date'];
const candidateFields = ['subject_ref', 'consent', 'facts', 'preferences'];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function invalid(details: FieldDetail[]): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The request payload is invalid.', false, details.slice(0, 20));
}
function fail(path: string, code: string): never { invalid([{ path, code }]); }

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'EXPECTED_OBJECT');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, 'UNKNOWN_PROPERTY');
  return record;
}
function string(value: unknown, path: string, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string') fail(path, 'EXPECTED_STRING');
  const length = [...value].length;
  if (length < min || length > max) fail(path, 'LENGTH_OUT_OF_RANGE');
  if (pattern && !pattern.test(value)) fail(path, 'INVALID_FORMAT');
  return value;
}
function optionalString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return string(value, path, 1, max);
}
function date(value: unknown, path: string): string {
  const text = string(value, path, 10, 10);
  if (!datePattern.test(text)) fail(path, 'EXPECTED_DATE');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(path, 'EXPECTED_DATE');
  return text;
}
export const refPattern = /^[A-Za-z0-9._-]+$/;

function job(value: unknown, path: string): JobInput {
  const record = object(value, path, ['kind', 'text']);
  if (record.kind !== 'text') fail(`${path}.kind`, 'UNSUPPORTED_KIND');
  const text = string(record.text, `${path}.text`, limits.jobMinCharacters, limits.jobMaxCharacters);
  if (text.trim().length < limits.jobMinCharacters) fail(`${path}.text`, 'MISSING_CONTENT');
  return { kind: 'text', text };
}

function options(value: unknown): Options {
  if (value === undefined) return { locale: 'en', timeout_seconds: limits.maxTimeoutSeconds };
  const record = object(value, 'options', ['locale', 'timeout_seconds']);
  if (record.locale !== undefined && record.locale !== 'en') fail('options.locale', 'UNSUPPORTED_LOCALE');
  let timeout: number = limits.maxTimeoutSeconds;
  if (record.timeout_seconds !== undefined) {
    if (typeof record.timeout_seconds !== 'number' || !Number.isInteger(record.timeout_seconds)
      || record.timeout_seconds < limits.minTimeoutSeconds || record.timeout_seconds > limits.maxTimeoutSeconds) fail('options.timeout_seconds', 'OUT_OF_RANGE');
    timeout = record.timeout_seconds;
  }
  return { locale: 'en', timeout_seconds: timeout };
}

function facts(value: unknown): CandidateFact[] {
  if (!Array.isArray(value)) fail('candidate.facts', 'EXPECTED_ARRAY');
  if (value.length < 1 || value.length > limits.maxFacts) fail('candidate.facts', 'COUNT_OUT_OF_RANGE');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `candidate.facts[${index}]`;
    const record = object(entry, path, factFields);
    const id = string(record.id, `${path}.id`, 1, 80, refPattern);
    if (seen.has(id)) fail(`${path}.id`, 'DUPLICATE_ID');
    seen.add(id);
    if (typeof record.kind !== 'string' || !(factKinds as readonly string[]).includes(record.kind)) fail(`${path}.kind`, 'UNSUPPORTED_KIND');
    const parsed: CandidateFact = {
      id, kind: record.kind as FactKind, text: string(record.text, `${path}.text`, 1, 2000),
      employer: optionalString(record.employer, `${path}.employer`, 160),
      title: optionalString(record.title, `${path}.title`, 160),
      institution: optionalString(record.institution, `${path}.institution`, 160),
      credential: optionalString(record.credential, `${path}.credential`, 160),
      start_date: record.start_date === undefined ? undefined : date(record.start_date, `${path}.start_date`),
      end_date: record.end_date === undefined ? undefined : record.end_date === null ? null : date(record.end_date, `${path}.end_date`),
    };
    if (parsed.start_date && parsed.end_date && parsed.end_date < parsed.start_date) fail(`${path}.end_date`, 'BEFORE_START');
    for (const key of ['employer', 'title', 'institution', 'credential'] as const) if (parsed[key] === undefined) delete parsed[key];
    return parsed;
  });
}

function candidate(value: unknown): Candidate {
  const record = object(value, 'candidate', candidateFields);
  const consent = object(record.consent, 'candidate.consent', ['purpose', 'granted_at']);
  if (typeof consent.purpose !== 'string' || !(consentPurposes as readonly string[]).includes(consent.purpose)) {
    fail('candidate.consent.purpose', 'UNSUPPORTED_PURPOSE');
  }
  const grantedAt = string(consent.granted_at, 'candidate.consent.granted_at', 20, 40);
  const grantedMs = Date.parse(grantedAt);
  if (Number.isNaN(grantedMs)) fail('candidate.consent.granted_at', 'EXPECTED_TIMESTAMP');
  if (grantedMs > Date.now() + 300_000) fail('candidate.consent.granted_at', 'IN_FUTURE');
  const preferences = record.preferences === undefined
    ? { preparation_only: true }
    : object(record.preferences, 'candidate.preferences', ['preparation_only']);
  if (preferences.preparation_only !== undefined && typeof preferences.preparation_only !== 'boolean') fail('candidate.preferences.preparation_only', 'EXPECTED_BOOLEAN');
  return {
    subject_ref: string(record.subject_ref, 'candidate.subject_ref', 1, 128, refPattern),
    consent: { purpose: consent.purpose as ConsentPurpose, granted_at: new Date(grantedMs).toISOString() },
    facts: facts(record.facts),
    preferences: { preparation_only: preferences.preparation_only === undefined ? true : preferences.preparation_only as boolean },
  };
}

export function parseIdempotencyKey(value: string | null): string {
  if (!value) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header for this operation.', false, [{ path: 'Idempotency-Key', code: 'REQUIRED' }]);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters of A-Z, a-z, 0-9, dot, underscore or hyphen.', false, [{ path: 'Idempotency-Key', code: 'INVALID_FORMAT' }]);
  return value;
}

/** Job-only request used by POST /v1/jobs/analyze. */
export function parseAnalyzeRequest(body: unknown): RunInput {
  const record = object(body, '', ['job', 'options']);
  return { operation: 'job_analysis', job: job(record.job, 'job'), options: options(record.options) };
}

/** Candidate+job request used by POST /v1/matches. */
export function parseMatchRequest(body: unknown): RunInput {
  const record = object(body, '', ['candidate', 'job', 'options']);
  const parsedCandidate = candidate(record.candidate);
  if (parsedCandidate.consent.purpose !== 'job_matching') {
    throw new ApiError(422, 'CONSENT_MISMATCH', 'Consent purpose must be job_matching for this operation.', false, [{ path: 'candidate.consent.purpose', code: 'MISMATCH' }]);
  }
  return { operation: 'match', candidate: parsedCandidate, job: job(record.job, 'job'), options: options(record.options) };
}

/** Candidate+job request used by POST /v1/cv/tailor. */
export function parseTailorRequest(body: unknown): RunInput {
  const record = object(body, '', ['candidate', 'job', 'options']);
  const parsedCandidate = candidate(record.candidate);
  if (parsedCandidate.consent.purpose !== 'cv_tailoring') {
    throw new ApiError(422, 'CONSENT_MISMATCH', 'Consent purpose must be cv_tailoring for this operation.', false, [{ path: 'candidate.consent.purpose', code: 'MISMATCH' }]);
  }
  return { operation: 'cv_tailoring', candidate: parsedCandidate, job: job(record.job, 'job'), options: options(record.options) };
}

/** Typed task creation used by POST /v1/runs. */
export function parseCreateRunRequest(body: unknown): RunInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('', 'EXPECTED_OBJECT');
  const record = body as Record<string, unknown>;
  const operation = record.operation;
  if (typeof operation !== 'string' || !(operations as readonly string[]).includes(operation)) fail('operation', 'UNSUPPORTED_OPERATION');
  // `operation` selects the canonical payload; it is not forwarded to the
  // operation-specific parser (which rejects unknown properties).
  const inner = { job: record.job, options: record.options, candidate: record.candidate };
  if (operation === 'job_analysis') {
    if ('candidate' in record) fail('candidate', 'NOT_ALLOWED');
    return parseAnalyzeRequest({ job: inner.job, options: inner.options });
  }
  if (operation === 'match') return parseMatchRequest(inner);
  if (operation === 'cv_tailoring') return parseTailorRequest(inner);
  // application_prepare is advertised as unavailable.
  throw new ApiError(422, 'FEATURE_DISABLED', 'This operation is not implemented yet. Check /v1/capabilities.', false, [{ path: 'operation', code: 'FEATURE_DISABLED' }]);
}

/** Sorted-key JSON so semantically equal payloads hash identically. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Re-validation of a stored snapshot. The run engine never trusts that the row
 * it reads was written by a valid request, and errors here are permanent.
 */
export function revalidateStoredInput(value: unknown): RunInput {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    const record = value as Record<string, unknown>;
    const operation = record.operation;
    if (operation === 'job_analysis') return parseAnalyzeRequest({ job: record.job, options: record.options });
    if (operation === 'match') return parseMatchRequest({ candidate: record.candidate, job: record.job, options: record.options });
    if (operation === 'cv_tailoring') return parseTailorRequest({ candidate: record.candidate, job: record.job, options: record.options });
    throw new Error('unsupported stored operation');
  } catch (error) {
    if (error instanceof ApiError) throw new Error(`Stored input failed validation: ${error.details[0]?.code ?? error.code}`);
    throw error instanceof Error ? error : new Error('Stored input failed validation');
  }
}
