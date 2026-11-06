#!/usr/bin/env bun
// Install the jobauto MCP server into a career-ops checkout.
//
// This writes configuration only. It never copies credentials, candidate data,
// or reports into the career-ops repository. The MCP process inherits
// JOBAUTO_ORIGIN and JOBAUTO_API_KEY from the shell that starts the AI CLI.

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const jobautoRoot = path.resolve(here, '../..');
export const mcpEntry = path.join(jobautoRoot, 'integrations/mcp/server.ts');
export const skillPath = path.join(here, 'skill.md');
export const skillStart = '<!-- jobauto:start -->';
export const skillEnd = '<!-- jobauto:end -->';

type Json = Record<string, any>;

export function buildClaudeConfig(existing: Json = {}, command = process.execPath, entry = mcpEntry): Json {
  return {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      jobauto: { type: 'stdio', command, args: [entry] },
    },
  };
}

export function buildOpenCodeConfig(existing: Json = {}, command = process.execPath, entry = mcpEntry): Json {
  return {
    ...existing,
    mcp: {
      ...(existing.mcp ?? {}),
      jobauto: { type: 'local', command: [command, entry], enabled: true },
    },
  };
}

export function upsertSkill(existing: string, skill: string): string {
  const block = `${skillStart}\n${skill.trim()}\n${skillEnd}`;
  const pattern = new RegExp(`${escapeRegExp(skillStart)}[\\s\\S]*?${escapeRegExp(skillEnd)}`);
  if (pattern.test(existing)) return existing.replace(pattern, block);
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function parseJson(file: string, label: string): Promise<Json> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top-level JSON must be an object');
    return value;
  } catch (error) {
    throw new Error(`${label} at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const rootArg = valueAfter(args, '--root') ?? process.env.CAREER_OPS_ROOT;
  if (!rootArg) {
    console.error('Usage: bun run career-ops:connect --root /path/to/career-ops [--with-skill] [--dry-run]');
    process.exit(2);
  }
  const root = path.resolve(rootArg);
  for (const required of ['AGENTS.md', 'modes/oferta.md']) {
    try { await stat(path.join(root, required)); }
    catch { console.error(`Not a career-ops checkout: missing ${required} under ${root}`); process.exit(2); }
  }

  const claudePath = path.join(root, '.mcp.json');
  const openCodePath = path.join(root, 'opencode.json');
  const existingClaude = await readFile(claudePath, 'utf8').then(JSON.parse).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${claudePath} must contain valid JSON before this connector can merge it: ${String(error)}`);
  });
  const existingOpenCode = await readFile(openCodePath, 'utf8').then(JSON.parse).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${openCodePath} must contain valid JSON before this connector can merge it: ${String(error)}`);
  });

  const claude = buildClaudeConfig(existingClaude);
  const openCode = buildOpenCodeConfig(existingOpenCode);
  if (args.includes('--dry-run')) {
    console.log(`--- ${claudePath}\n${JSON.stringify(claude, null, 2)}\n--- ${openCodePath}\n${JSON.stringify(openCode, null, 2)}`);
    return;
  }
  await writeFile(claudePath, `${JSON.stringify(claude, null, 2)}\n`, 'utf8');
  await writeFile(openCodePath, `${JSON.stringify(openCode, null, 2)}\n`, 'utf8');
  console.log(`Installed jobauto MCP in:\n  ${claudePath}\n  ${openCodePath}`);

  if (args.includes('--with-skill')) {
    const customPath = path.join(root, 'modes/_custom.md');
    const existing = await readFile(customPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '# Custom career-ops rules\n';
      throw error;
    });
    const skill = await readFile(skillPath, 'utf8');
    await writeFile(customPath, upsertSkill(existing, skill), 'utf8');
    console.log(`Installed managed skill block in ${customPath}`);
  }

  console.log('\nStart the API, then launch the AI CLI from the career-ops directory with:');
  console.log('  export JOBAUTO_ORIGIN="http://127.0.0.1:4310"');
  console.log('  export JOBAUTO_API_KEY="$(cat /path/to/jobauto/.local/key-<id>.txt)"');
  console.log('  export JOBAUTO_SUBJECT_REF="career-ops"');
  console.log('The key is transported by the environment, never written into career-ops.');
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
