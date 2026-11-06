#!/usr/bin/env node
// MCP (Model Context Protocol) stdio adapter for the jobauto /v1 API.
//
// Why this shape: local-first tools such as career-ops own the candidate's files
// and the human's attention, and they host MCP servers from the user's own CLI
// configuration. They do not call a hosted REST API, and this repository must not
// read a user's files. A thin stdio server is therefore the smallest honest
// bridge: the cockpit stays local, the durable grounded execution stays here.
//
// Deliberate limits:
//  - The origin and the credential come from the environment only. No tool
//    argument can redirect a request, so a prompt cannot exfiltrate the key.
//  - No file access. Candidate facts are passed in explicitly by the caller.
//  - No submission capability exists, which matches career-ops' own rule that
//    the agent prepares and the human clicks Submit.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, protocol 2025-11-25.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const serverInfo = { name: 'jobauto', title: 'jobauto job intelligence', version: '0.3.0' };
export const supportedProtocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const latestProtocolVersion = supportedProtocolVersions[0]!;

export interface ServerOptions {
  origin: string;
  apiKey: string;
  /** Bounded wait for a queued run to reach a terminal state. */
  runTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

const factKinds = ['summary', 'skill', 'experience', 'education', 'certification', 'project', 'achievement'];
const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject_ref', 'facts'],
  properties: {
    subject_ref: { type: 'string', minLength: 1, maxLength: 128, description: 'The client-side reference the candidate grant was issued for.' },
    facts: {
      type: 'array', minItems: 1, maxItems: 200,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'kind', 'text'],
        properties: {
          id: { type: 'string', maxLength: 80 },
          kind: { type: 'string', enum: factKinds },
          text: { type: 'string', maxLength: 2000 },
          employer: { type: 'string', maxLength: 160 },
          title: { type: 'string', maxLength: 160 },
          institution: { type: 'string', maxLength: 160 },
          credential: { type: 'string', maxLength: 160 },
          start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          end_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
    consent_granted_at: { type: 'string', description: 'ISO-8601 time the candidate authorized this use. Defaults to now.' },
  },
};

const jobText = { type: 'string', minLength: 20, maxLength: 30000, description: 'The full posting text.' };

export const tools = [
  {
    name: 'analyze_job',
    description: 'Extract grounded, quotable requirements from a posting. Every requirement carries the verbatim sentence it came from, re-verified against the submitted text. Returns a completed run result.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_text'], properties: { job_text: jobText } },
  },
  {
    name: 'match_candidate',
    description: 'Assess each requirement against explicitly supplied candidate facts. Returns supported/partial/not_evidenced with the fact IDs behind each assessment. Never returns a hiring probability or a numeric score.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_text', 'candidate'], properties: { job_text: jobText, candidate: candidateSchema } },
  },
  {
    name: 'tailor_cv',
    description: 'Produce an immutable, versioned tailored CV artifact in extractive mode: every line is exact supplied fact text or its exact title/employer/dates. Returns the artifact content and its SHA-256 checksum.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_text', 'candidate'], properties: { job_text: jobText, candidate: candidateSchema } },
  },
  {
    name: 'get_run',
    description: 'Read authoritative status, result and usage for a run.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } },
  },
  {
    name: 'get_artifact',
    description: 'Read an immutable artifact by id, including its checksum. Expired artifacts return 410 instead of stale content.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['artifact_id'], properties: { artifact_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } },
  },
] as const;

export class ApiFailure extends Error {
  constructor(public code: string, message: string, public status: number, public retryable = false) { super(message); }
}

/** Sorted-key hashing so an identical request reuses the original run. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

const terminal = new Set(['completed', 'partially_completed', 'failed', 'cancelled', 'expired']);

export function createMcpServer(options: ServerOptions) {
  // The origin is validated once: https, or loopback http for local development.
  const origin = new URL(options.origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
    throw new Error('JOBAUTO_ORIGIN must be https, or http on loopback for local development');
  }
  if (origin.origin !== options.origin.replace(/\/$/, '')) throw new Error('JOBAUTO_ORIGIN must be an exact origin');
  if (!options.apiKey) throw new Error('JOBAUTO_API_KEY is required');

  const base = origin.origin;
  const doFetch = options.fetchImpl ?? fetch;
  const runTimeoutMs = options.runTimeoutMs ?? 90_000;
  const pollIntervalMs = options.pollIntervalMs ?? 750;

  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = (body.error ?? {}) as Record<string, unknown>;
      throw new ApiFailure(
        typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
        typeof error.message === 'string' ? error.message : `Request failed with ${response.status}`,
        response.status,
        error.retryable === true,
      );
    }
    return (body.data ?? {}) as Record<string, unknown>;
  }

  function candidateArgument(value: unknown, purpose: 'job_matching' | 'cv_tailoring') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiFailure('INVALID_ARGUMENT', 'candidate must be an object', 400);
    const record = value as Record<string, unknown>;
    const grantedAt = typeof record.consent_granted_at === 'string' ? record.consent_granted_at : new Date().toISOString();
    return {
      subject_ref: record.subject_ref,
      consent: { purpose, granted_at: grantedAt },
      facts: record.facts,
      preferences: { preparation_only: true },
    };
  }

  async function submit(operation: 'job_analysis' | 'match' | 'cv_tailoring', payload: unknown, path: string) {
    const key = `mcp-${createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 56)}`;
    const accepted = await call(path, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
    const runId = typeof accepted.run_id === 'string' ? accepted.run_id : '';
    if (!runId) throw new ApiFailure('ACCEPTED_WITHOUT_RUN', 'The service accepted the request without returning a run id', 502);
    return awaitOnce(runId, operation);
  }

  async function awaitOnce(runId: string, operation: string) {
    const deadline = Date.now() + runTimeoutMs;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      last = await call(`/v1/runs/${runId}`);
      const status = typeof last.status === 'string' ? last.status : 'queued';
      if (terminal.has(status)) {
        if (status !== 'completed') {
          // A non-completed terminal state is reported as a failure, not a result.
          const error = (last.error ?? {}) as Record<string, unknown>;
          throw new ApiFailure(
            typeof error.code === 'string' ? error.code : `RUN_${status.toUpperCase()}`,
            typeof error.message === 'string' ? error.message : `The ${operation} run ended as ${status}`,
            200, false,
          );
        }
        return { run: last, result: last.result };
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new ApiFailure('RUN_TIMEOUT', `Run ${runId} did not finish within ${runTimeoutMs} ms; poll get_run for its current state.`, 200, true);
  }

  async function invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'analyze_job':
        return await submit('job_analysis', { job: { kind: 'text', text: args.job_text } }, '/v1/jobs/analyze');
      case 'match_candidate':
        return await submit('match', { candidate: candidateArgument(args.candidate, 'job_matching'), job: { kind: 'text', text: args.job_text } }, '/v1/matches');
      case 'tailor_cv': {
        // One run yields one immutable artifact; read it back rather than
        // guessing its shape, so the checksum the caller sees is the stored one.
        const { run, result } = await submit('cv_tailoring', { candidate: candidateArgument(args.candidate, 'cv_tailoring'), job: { kind: 'text', text: args.job_text } }, '/v1/cv/tailor');
        const artifactId = (result as Record<string, unknown> | null | undefined)?.artifact_id;
        if (typeof artifactId !== 'string') throw new ApiFailure('ARTIFACT_MISSING', 'The tailoring run completed without an artifact id', 502);
        const artifact = await call(`/v1/artifacts/${artifactId}`);
        return { run_id: run.run_id, artifact };
      }
      case 'get_run':
        return await call(`/v1/runs/${args.run_id}`);
      case 'get_artifact':
        return await call(`/v1/artifacts/${args.artifact_id}`);
      default:
        throw new ApiFailure('UNKNOWN_TOOL', `Unknown tool: ${name}`, -32601);
    }
  }

  async function handle(message: unknown): Promise<Record<string, unknown> | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const request = message as Record<string, unknown>;
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = (request.params ?? {}) as Record<string, unknown>;
    // Notifications (no id) must never produce a response.
    const notify = !('id' in request);

    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0', id,
        result: {
          // Echo the client's version when supported, else offer our latest.
          protocolVersion: supportedProtocolVersions.includes(requested) ? requested : latestProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...serverInfo, description: 'Durable, grounded job analysis, evidence matching and extractive CV tailoring.' },
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = tools.some(tool => tool.name === name);
      if (!known) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      if (args.job_text !== undefined && (typeof args.job_text !== 'string' || args.job_text.length < 20 || args.job_text.length > 30000)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'job_text must be a string of 20-30000 characters.' }], isError: true } };
      }
      try {
        const data = await invoke(name, args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
      } catch (error) {
        // Tool failures stay inside the result envelope; transport errors do not.
        const failure = error instanceof ApiFailure ? error : new ApiFailure('TRANSPORT_ERROR', error instanceof Error ? error.message : 'Request failed', 503);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify({ error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, null, 2) }], isError: true },
        };
      }
    }
    if (notify) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { handle, origin: base };
}

async function main() {
  const origin = process.env.JOBAUTO_ORIGIN ?? '';
  const apiKey = process.env.JOBAUTO_API_KEY ?? '';
  let server: ReturnType<typeof createMcpServer>;
  try {
    server = createMcpServer({ origin, apiKey, runTimeoutMs: Number(process.env.JOBAUTO_RUN_TIMEOUT_MS || 90000) });
  } catch (error) {
    // stderr only: stdout is the protocol channel.
    console.error(`jobauto MCP: ${error instanceof Error ? error.message : 'invalid configuration'}`);
    process.exit(2);
  }
  console.error(`jobauto MCP ready for ${server.origin}`);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const response = await server.handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

// Only start the transport when executed directly, never when imported by tests.
// `import.meta.main` exists in Bun; the URL comparison covers plain Node.
const isEntry = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;
if (isEntry) void main();
