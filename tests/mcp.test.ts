import {test,expect,describe} from 'bun:test';
import {createMcpServer,tools,ApiFailure} from '../integrations/mcp/server';

// The adapter is exercised through its protocol surface with an injected fetch,
// so no network, no credential and no running API are needed here.

interface Recorded { url: string; init: RequestInit }
const jobText='Example Ltd seeks a Backend Engineer with TypeScript and API testing experience. You must have 3+ years with Node.js.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeApi(overrides: { runStatus?: string; failRun?: boolean } = {}) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/v1/jobs/analyze' || path === '/v1/matches' || path === '/v1/cv/tailor') {
      return json({ data: { run_id: '11111111-1111-4111-8111-111111111111', status: 'queued' } }, 202);
    }
    if (path.startsWith('/v1/runs/')) {
      if (!path.endsWith('11111111-1111-4111-8111-111111111111')) {
        return json({ error: { code: 'NOT_FOUND', message: 'Resource not found.', retryable: false } }, 404);
      }
      if (overrides.failRun) {
        return json({ data: { run_id: '11111111-1111-4111-8111-111111111111', status: 'failed', result: null,
          error: { code: 'EXECUTION_FAILED', message: 'The execution could not be completed.', retryable: false } } });
      }
      const status = overrides.runStatus ?? 'completed';
      return json({ data: { run_id: '11111111-1111-4111-8111-111111111111', status,
        result: path.includes('runs') ? { kind: 'job_analysis', job: { title: 'Backend Engineer' }, artifact_id: '22222222-2222-4222-8222-222222222222' } : null,
        usage: { model: null, prompt_version: 'deterministic-v1' } } });
    }
    if (path.startsWith('/v1/artifacts/')) {
      return json({ data: { artifact_id: '22222222-2222-4222-8222-222222222222', version: 1,
        checksum: 'a'.repeat(64), content: { kind: 'tailored_cv', mode: 'extractive', sections: [], suggestions: [], limitations: [] } } });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'Resource not found.', retryable: false } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const remote = () => createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl: fakeApi().fetchImpl, pollIntervalMs: 1 });

async function toolCall(server: { handle: (m: unknown) => Promise<Record<string, unknown> | null> }, name: string, args: Record<string, unknown>) {
  return await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }) as Record<string, any>;
}

describe('MCP lifecycle', () => {
  test('initialize negotiates a supported version and advertises tools', async () => {
    const server = remote();
    const supported = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as Record<string, any>;
    expect(supported.result.protocolVersion).toBe('2025-06-18');
    expect(supported.result.capabilities.tools).toBeDefined();
    expect(supported.result.serverInfo.name).toBe('jobauto');

    const unknown = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as Record<string, any>;
    expect(unknown.result.protocolVersion).toBe('2025-11-25');
  });

  test('notifications produce no response and unknown methods are protocol errors', async () => {
    const server = remote();
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const unknown = await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }) as Record<string, any>;
    expect(unknown.error.code).toBe(-32601);
    const invalid = (await server.handle('not json')) as Record<string, any>;
    expect(invalid.error.code).toBe(-32600);
  });

  test('tools/list exposes exactly the implemented capabilities', async () => {
    const server = remote();
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as Record<string, any>;
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['analyze_job', 'match_candidate', 'tailor_cv', 'get_run', 'get_artifact']);
    for (const tool of listed.result.tools) expect(tool.inputSchema.type).toBe('object');
    // No tool name or input property can submit an application: the whole
    // surface is preparation and retrieval, matching career-ops' own rule.
    for (const tool of listed.result.tools) {
      expect(tool.name).not.toMatch(/submit|apply|send/i);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('submit');
    }
  });
});

describe('tool calls', () => {
  test('analyze_job returns the completed run and result', async () => {
    const server = remote();
    const response = await toolCall(server, 'analyze_job', { job_text: jobText });
    expect(response.result.isError).toBeUndefined();
    const payload = JSON.parse(response.result.content[0].text);
    expect(payload.result.job.title).toBe('Backend Engineer');
    expect(payload.run.status).toBe('completed');
    expect(payload.run.usage.prompt_version).toBe('deterministic-v1');
  });

  test('the candidate grant and operation purpose are set per operation', async () => {
    const { fetchImpl, calls } = fakeApi();
    const server = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl, pollIntervalMs: 1 });
    await toolCall(server, 'match_candidate', { job_text: jobText, candidate: { subject_ref: 'candidate-42', facts: [{ id: 'f1', kind: 'skill', text: 'TypeScript' }] } });
    const match = calls.find(call => call.url.endsWith('/v1/matches'));
    const body = JSON.parse(String(match?.init.body));
    expect(body.candidate.subject_ref).toBe('candidate-42');
    expect(body.candidate.consent.purpose).toBe('job_matching');
    expect(body.candidate.preferences.preparation_only).toBe(true);

    await toolCall(server, 'tailor_cv', { job_text: jobText, candidate: { subject_ref: 'candidate-42', facts: [{ id: 'f1', kind: 'skill', text: 'TypeScript' }] } });
    const tailor = calls.find(call => call.url.endsWith('/v1/cv/tailor'));
    expect(JSON.parse(String(tailor?.init.body)).candidate.consent.purpose).toBe('cv_tailoring');
  });

  test('tailor_cv reads the stored artifact so the checksum reported is the stored one', async () => {
    const server = remote();
    const response = await toolCall(server, 'tailor_cv', { job_text: jobText, candidate: { subject_ref: 'candidate-42', facts: [{ id: 'f1', kind: 'skill', text: 'TypeScript' }] } });
    const payload = JSON.parse(response.result.content[0].text);
    expect(payload.artifact.artifact_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(payload.artifact.checksum).toBe('a'.repeat(64));
    expect(payload.artifact.content.mode).toBe('extractive');
  });

  test('identical payloads reuse one idempotency key; the credential never appears in output', async () => {
    const { fetchImpl, calls } = fakeApi();
    const server = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl, pollIntervalMs: 1 });
    const args = { job_text: jobText };
    const first = await toolCall(server, 'analyze_job', args);
    await toolCall(server, 'analyze_job', { ...args, options: undefined });
    const keys = calls.filter(call => call.url.endsWith('/v1/jobs/analyze')).map(call => (call.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(JSON.stringify(first)).not.toContain('ja_live_secret.key');
    // The credential is sent as a bearer header, never as a query parameter.
    for (const call of calls) expect(call.url).not.toContain('ja_live');
  });

  test('a tool argument cannot redirect the request to another origin', async () => {
    const { fetchImpl, calls } = fakeApi();
    const server = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl, pollIntervalMs: 1 });
    await toolCall(server, 'analyze_job', { job_text: jobText, origin: 'https://attacker.example', url: 'https://attacker.example/v1/runs/x' });
    for (const call of calls) expect(call.url.startsWith('https://api.example.test/')).toBe(true);
  });

  test('API and run failures are tool errors, not invented results', async () => {
    const notFound = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl: fakeApi().fetchImpl, pollIntervalMs: 1 });
    const missing = await toolCall(notFound, 'get_run', { run_id: '33333333-3333-4333-8333-333333333333' });
    expect(missing.result.isError).toBe(true);
    expect(JSON.parse(missing.result.content[0].text).error.code).toBe('NOT_FOUND');

    const failed = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl: fakeApi({ failRun: true }).fetchImpl, pollIntervalMs: 1 });
    const response = await toolCall(failed, 'analyze_job', { job_text: jobText });
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text).error.code).toBe('EXECUTION_FAILED');
  });

  test('an unknown tool is a protocol error and short text is refused before any request', async () => {
    const { fetchImpl, calls } = fakeApi();
    const server = createMcpServer({ origin: 'https://api.example.test', apiKey: 'ja_live_secret.key', fetchImpl, pollIntervalMs: 1 });
    const unknown = await toolCall(server, 'submit_application', {});
    expect(unknown.error.code).toBe(-32602);
    const short = await toolCall(server, 'analyze_job', { job_text: 'too short' });
    expect(short.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('configuration boundaries', () => {
  test('origin must be https, or http on loopback', () => {
    expect(() => createMcpServer({ origin: 'http://api.example.test', apiKey: 'k' })).toThrow(/https/);
    expect(() => createMcpServer({ origin: 'https://api.example.test/prefix', apiKey: 'k' })).toThrow(/exact origin/);
    expect(() => createMcpServer({ origin: 'https://api.example.test', apiKey: '' })).toThrow(/API_KEY/);
    expect(() => createMcpServer({ origin: 'http://127.0.0.1:4310', apiKey: 'k' })).not.toThrow();
  });

  test('ApiFailure carries the machine-readable code through', () => {
    const failure = new ApiFailure('CANDIDATE_DENIED', 'denied', 403);
    expect(failure.code).toBe('CANDIDATE_DENIED');
    expect(failure.status).toBe(403);
  });
});
