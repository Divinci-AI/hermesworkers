import { describe, it, expect } from 'vitest';
import { collectProviderKeys, providerKeysWithByok } from '../src/lib/container';
import type { Env } from '../src/lib/container';

// Minimal Env stub — only the fields collectProviderKeys reads matter here.
function env(overrides: Partial<Env> = {}): Env {
  return { HERMES: {} as unknown as Env['HERMES'], ...overrides };
}

describe('collectProviderKeys — BYOK providers', () => {
  it('maps GEMINI_API_KEY to both GEMINI_API_KEY and GOOGLE_API_KEY', () => {
    const keys = collectProviderKeys(env({ GEMINI_API_KEY: 'g-1' }));
    expect(keys.GEMINI_API_KEY).toBe('g-1');
    expect(keys.GOOGLE_API_KEY).toBe('g-1');
  });

  it('omits providers whose key is unset', () => {
    const keys = collectProviderKeys(env({ ANTHROPIC_API_KEY: 'a-1' }));
    expect(keys.ANTHROPIC_API_KEY).toBe('a-1');
    expect(keys.OPENAI_API_KEY).toBeUndefined();
    expect(keys.NOUS_API_KEY).toBeUndefined();
  });
});

describe('collectProviderKeys — platform Cloudflare Workers AI', () => {
  it('passes CF token + account id only as a pair', () => {
    const keys = collectProviderKeys(
      env({ CLOUDFLARE_API_KEY: 'cf-tok', CLOUDFLARE_ACCOUNT_ID: 'acct-1' }),
    );
    expect(keys.CLOUDFLARE_API_KEY).toBe('cf-tok');
    expect(keys.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
  });

  it('drops a half-configured CF setup (token without account id)', () => {
    const keys = collectProviderKeys(env({ CLOUDFLARE_API_KEY: 'cf-tok' }));
    expect(keys.CLOUDFLARE_API_KEY).toBeUndefined();
    expect(keys.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });
});

describe('collectProviderKeys — platform Vertex AI', () => {
  it('passes project + location + SA JSON only as a complete set', () => {
    const keys = collectProviderKeys(
      env({ VERTEXAI_PROJECT: 'proj', VERTEXAI_LOCATION: 'us-central1', VERTEX_SA_JSON: '{"x":1}' }),
    );
    expect(keys.VERTEXAI_PROJECT).toBe('proj');
    expect(keys.VERTEXAI_LOCATION).toBe('us-central1');
    expect(keys.VERTEX_SA_JSON).toBe('{"x":1}');
  });

  it('drops a partial Vertex setup (project + location, no SA JSON)', () => {
    const keys = collectProviderKeys(
      env({ VERTEXAI_PROJECT: 'proj', VERTEXAI_LOCATION: 'us-central1' }),
    );
    expect(keys.VERTEXAI_PROJECT).toBeUndefined();
    expect(keys.VERTEXAI_LOCATION).toBeUndefined();
    expect(keys.VERTEX_SA_JSON).toBeUndefined();
  });
});

describe('collectProviderKeys — Buffer MCP', () => {
  it('passes the Buffer flag and key only when enabled', () => {
    const keys = collectProviderKeys(
      env({ HERMES_BUFFER_MCP_ENABLED: 'true', MCP_BUFFER_API_KEY: 'buf-key' }),
    );
    expect(keys.HERMES_BUFFER_MCP_ENABLED).toBe('true');
    expect(keys.MCP_BUFFER_API_KEY).toBe('buf-key');
  });

  it('does not leak the Buffer key when the flag is off', () => {
    const keys = collectProviderKeys(env({ MCP_BUFFER_API_KEY: 'buf-key' }));
    expect(keys.HERMES_BUFFER_MCP_ENABLED).toBeUndefined();
    expect(keys.MCP_BUFFER_API_KEY).toBeUndefined();
  });
});

describe('collectProviderKeys — Canva MCP', () => {
  it('passes the Canva flag and OAuth seed only when enabled', () => {
    const keys = collectProviderKeys(
      env({ HERMES_CANVA_MCP_ENABLED: 'true', MCP_CANVA_OAUTH_JSON: '{"client_id":"c","refresh_token":"r"}' }),
    );
    expect(keys.HERMES_CANVA_MCP_ENABLED).toBe('true');
    expect(keys.MCP_CANVA_OAUTH_JSON).toBe('{"client_id":"c","refresh_token":"r"}');
  });

  // The seed IS the credential — a refresh_token that reaches a container we
  // did not mean to enable is a live Canva grant on someone else's disk.
  it('does not leak the Canva OAuth seed when the flag is off', () => {
    const keys = collectProviderKeys(env({ MCP_CANVA_OAUTH_JSON: '{"client_id":"c","refresh_token":"r"}' }));
    expect(keys.HERMES_CANVA_MCP_ENABLED).toBeUndefined();
    expect(keys.MCP_CANVA_OAUTH_JSON).toBeUndefined();
  });
});

describe('providerKeysWithByok — customer key overlays platform', () => {
  it('overlays the BYOK key over the platform default for its provider', () => {
    const keys = providerKeysWithByok(
      env({ ANTHROPIC_API_KEY: 'platform-a' }),
      'anthropic',
      'customer-a',
    );
    expect(keys.ANTHROPIC_API_KEY).toBe('customer-a');
  });

  it('leaves platform Vertex/CF creds intact when a BYOK key is supplied', () => {
    const keys = providerKeysWithByok(
      env({
        CLOUDFLARE_API_KEY: 'cf-tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct-1',
        VERTEXAI_PROJECT: 'proj',
        VERTEXAI_LOCATION: 'us-central1',
        VERTEX_SA_JSON: '{"x":1}',
      }),
      'openai',
      'customer-o',
    );
    expect(keys.OPENAI_API_KEY).toBe('customer-o');
    expect(keys.CLOUDFLARE_API_KEY).toBe('cf-tok');
    expect(keys.VERTEXAI_PROJECT).toBe('proj');
  });
});
