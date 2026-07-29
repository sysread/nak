/**
 * Coverage for the MCP status UI primitives. Pure functions, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  mcpStatusLabel,
  mcpStatusNeedsAttention,
  mcpStatusHint,
  mcpIntegrationToolboxName,
} from '../src/lib/ui/mcp';
import type { McpIntegration } from '../src/lib/supabase';

describe('mcpStatusLabel', () => {
  it('labels each status', () => {
  expect(mcpStatusLabel('authorized')).toBe('Connected');
  expect(mcpStatusLabel('revoked')).toBe('Disconnected');
  expect(mcpStatusLabel('expired')).toBe('Authorization expired');
  expect(mcpStatusLabel('pending')).toBe('Awaiting authorization');
  });
});

describe('mcpStatusNeedsAttention', () => {
  it('flags expired and revoked', () => {
  expect(mcpStatusNeedsAttention('expired')).toBe(true);
  expect(mcpStatusNeedsAttention('revoked')).toBe(true);
  });
  it('does not flag authorized or pending', () => {
  expect(mcpStatusNeedsAttention('authorized')).toBe(false);
  expect(mcpStatusNeedsAttention('pending')).toBe(false);
  });
});

describe('mcpStatusHint', () => {
  it('returns a hint for expired', () => {
  const hint = mcpStatusHint('expired');
  expect(hint).not.toBeNull();
  expect(hint).toContain('reauthorize');
  });
  it('returns a hint for revoked', () => {
  const hint = mcpStatusHint('revoked');
  expect(hint).not.toBeNull();
  expect(hint).toContain('reauthorize');
  });
  it('returns null for authorized and pending', () => {
  expect(mcpStatusHint('authorized')).toBeNull();
  expect(mcpStatusHint('pending')).toBeNull();
  });
});

describe('mcpIntegrationToolboxName', () => {
  it('prefixes the label with mcp:', () => {
  const integ: Pick<McpIntegration, 'label'> = { label: 'Fastmail' };
  expect(mcpIntegrationToolboxName(integ)).toBe('mcp:Fastmail');
  });
});
