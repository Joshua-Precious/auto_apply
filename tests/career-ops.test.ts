import { describe, expect, it } from 'bun:test';
import {
  buildClaudeConfig,
  buildOpenCodeConfig,
  skillEnd,
  skillStart,
  upsertSkill,
} from '../integrations/career-ops/connect';

describe('career-ops connector', () => {
  it('merges the jobauto server without dropping existing MCP servers', () => {
    const config = buildClaudeConfig({
      mcpServers: { playwright: { command: 'mcp-server-playwright' } },
    }, '/usr/local/bin/bun', '/repo/integrations/mcp/server.ts');
    expect(config.mcpServers.playwright.command).toBe('mcp-server-playwright');
    expect(config.mcpServers.jobauto).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/bun',
      args: ['/repo/integrations/mcp/server.ts'],
    });
  });

  it('builds an OpenCode local server entry without credentials', () => {
    const config = buildOpenCodeConfig({ mcp: { playwright: { enabled: true } } }, 'bun', '/repo/server.ts');
    expect(config.mcp.playwright).toEqual({ enabled: true });
    expect(config.mcp.jobauto).toEqual({
      type: 'local',
      command: ['bun', '/repo/server.ts'],
      enabled: true,
    });
    expect(JSON.stringify(config)).not.toContain('API_KEY');
  });

  it('updates the managed skill block in place and preserves user text', () => {
    const first = upsertSkill('# My rules\n\nKeep this.\n', 'First version');
    const second = upsertSkill(first, 'Second version');
    expect(second).toContain('# My rules');
    expect(second).toContain('Keep this.');
    expect(second).toContain('Second version');
    expect(second).not.toContain('First version');
    expect(second.match(new RegExp(skillStart, 'g'))).toHaveLength(1);
    expect(second.match(new RegExp(skillEnd, 'g'))).toHaveLength(1);
  });
});
