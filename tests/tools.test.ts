/**
 * Unit coverage for the tool registry and the individual tool handlers.
 *
 * These tests exercise the dispatch and argument-validation paths. They
 * don't drive a live Supabase — the handlers delegate every side effect
 * to a SupabaseService method, so we stub a fake service and assert the
 * right method was called with the right shape. Actual CRUD round-trips
 * against the live DB belong in an integration test layer (out of scope
 * for unit coverage here).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  buildToolList,
  buildToolCatalog,
  toOpenAIToolDef,
  executeToolCall,
  toggleTools,
  type ToolContext,
} from '../src/lib/tools';
import type { SupabaseService } from '../src/lib/supabase';

/**
 * Build a SupabaseService mock with just the methods the tool handlers
 * touch. Each spy captures its calls so tests can assert on them.
 */
function mockSupabase(): {
  svc: SupabaseService;
  spies: {
    setThreadToolsEnabled: ReturnType<typeof vi.fn>;
    searchMemories: ReturnType<typeof vi.fn>;
    createMemory: ReturnType<typeof vi.fn>;
    updateMemory: ReturnType<typeof vi.fn>;
    deleteMemory: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    setThreadToolsEnabled: vi.fn(async () => undefined),
    searchMemories: vi.fn(async () => [
      { id: 'm1', label: 'foo', data: 'bar', created_at: 't', updated_at: 't' },
    ]),
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'new-id',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
    updateMemory: vi.fn(async (id: string, patch: { label?: string; data?: string }) => ({
      id,
      label: patch.label ?? 'keep',
      data: patch.data ?? 'keep',
      created_at: 't',
      updated_at: 't',
    })),
    deleteMemory: vi.fn(async () => undefined),
  };
  // Cast is fine — the handlers only touch the methods we've implemented.
  const svc = spies as unknown as SupabaseService;
  return { svc, spies };
}

function ctxFor(svc: SupabaseService): ToolContext {
  return {
    supabase: svc,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('tool registry', () => {
  it('exposes toggle_tools plus every memory tool', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('toggle_tools');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_create');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_delete');
  });

  it('buildToolList returns only toggle_tools when disabled', () => {
    const list = buildToolList(false);
    expect(list).toHaveLength(1);
    expect(list[0].function.name).toBe('toggle_tools');
  });

  it('buildToolList returns every tool when enabled', () => {
    const list = buildToolList(true);
    expect(list.map((t) => t.function.name).sort()).toEqual(
      TOOLS.map((t) => t.name).sort()
    );
  });

  it('toOpenAIToolDef projects to the function-calling wire shape', () => {
    const wire = toOpenAIToolDef(toggleTools);
    expect(wire).toEqual({
      type: 'function',
      function: {
        name: toggleTools.name,
        description: toggleTools.description,
        parameters: toggleTools.parameters,
      },
    });
  });

  it('buildToolCatalog lists gated tools but omits toggle_tools itself', () => {
    const catalog = buildToolCatalog();
    expect(catalog).toContain('memory_search');
    expect(catalog).toContain('memory_create');
    expect(catalog).toContain('memory_update');
    expect(catalog).toContain('memory_delete');
    // toggle_tools is the switch itself, not something to advertise in
    // the catalog of gated tools.
    expect(catalog).not.toMatch(/^- toggle_tools/m);
  });

  it('buildToolCatalog omits the web-search hint by default', () => {
    // Without the opt-in, the prompt must not mention web search — we
    // don't want the model to claim capabilities the wire-level
    // `enable_web_search` flag didn't actually grant.
    const catalog = buildToolCatalog();
    expect(catalog).not.toMatch(/web/i);
  });

  it('buildToolCatalog adds a web-search hint when opted in', () => {
    // With the hint, the model must see both that it can search the
    // web AND that there's no function to call for it — otherwise it
    // tries to invoke a nonexistent tool on the next turn.
    const catalog = buildToolCatalog({ webSearch: true });
    expect(catalog).toMatch(/search the live web/i);
    expect(catalog).toMatch(/no tool to call/i);
  });

  it('executeToolCall dispatches by name', async () => {
    const { svc, spies } = mockSupabase();
    await executeToolCall('toggle_tools', { enable: true }, ctxFor(svc));
    expect(spies.setThreadToolsEnabled).toHaveBeenCalledWith('t-1', true);
  });

  it('executeToolCall throws on an unknown tool', async () => {
    const { svc } = mockSupabase();
    await expect(executeToolCall('bogus', {}, ctxFor(svc))).rejects.toThrow(
      /unknown tool/i
    );
  });
});

describe('toggle_tools', () => {
  it('writes the boolean through to Supabase', async () => {
    const { svc, spies } = mockSupabase();
    const result = await toggleTools.execute({ enable: false }, ctxFor(svc));
    expect(spies.setThreadToolsEnabled).toHaveBeenCalledWith('t-1', false);
    expect(result).toEqual({ enabled: false });
  });

  it('coerces non-boolean enable values', async () => {
    const { svc, spies } = mockSupabase();
    await toggleTools.execute({ enable: 'yes' as unknown as boolean }, ctxFor(svc));
    // Boolean('yes') === true
    expect(spies.setThreadToolsEnabled).toHaveBeenCalledWith('t-1', true);
  });
});

describe('memory_search', () => {
  const tool = TOOLS.find((t) => t.name === 'memory_search')!;

  it('passes trimmed query and default limit', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ query: '  foo  ' }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('foo', 20);
  });

  it('empty query lists everything', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({}, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 20);
  });

  it('clamps limit to the max', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 9999 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 100);
  });

  it('clamps limit to at least 1', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 0 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 1);
  });
});

describe('memory_create', () => {
  const tool = TOOLS.find((t) => t.name === 'memory_create')!;

  it('trims label and forwards data', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ label: '  note  ', data: 'body' }, ctxFor(svc));
    expect(spies.createMemory).toHaveBeenCalledWith('note', 'body');
  });

  it('rejects a missing label', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ data: 'body' }, ctxFor(svc))).rejects.toThrow(
      /label/
    );
  });

  it('rejects a missing data', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ label: 'x' }, ctxFor(svc))).rejects.toThrow(
      /data/
    );
  });
});

describe('memory_update', () => {
  const tool = TOOLS.find((t) => t.name === 'memory_update')!;

  it('forwards a label-only patch', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', label: 'new' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'new' });
  });

  it('forwards a data-only patch', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', data: 'new' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { data: 'new' });
  });

  it('forwards both fields when given both', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', label: 'a', data: 'b' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'a', data: 'b' });
  });

  it('rejects an empty patch', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ id: 'm1' }, ctxFor(svc))).rejects.toThrow(
      /at least one/
    );
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ label: 'x' }, ctxFor(svc))).rejects.toThrow(
      /id/
    );
  });
});

describe('memory_delete', () => {
  const tool = TOOLS.find((t) => t.name === 'memory_delete')!;

  it('forwards the id', async () => {
    const { svc, spies } = mockSupabase();
    const result = await tool.execute({ id: 'm1' }, ctxFor(svc));
    expect(spies.deleteMemory).toHaveBeenCalledWith('m1');
    expect(result).toEqual({ deleted: true });
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({}, ctxFor(svc))).rejects.toThrow(/id/);
  });
});
