import { describe, expect, it } from 'vitest';
import { PASSPHRASE_HEADER } from '../packages/core/src/index.js';
import { ask, buildCases, serverOrigin } from './verify-criteria.js';

describe('serverOrigin', () => {
  it('accepts https and cuts the value down to its origin', () => {
    expect(serverOrigin('https://magic-jev.vercel.app')).toEqual({ origin: 'https://magic-jev.vercel.app' });
    expect(serverOrigin('  https://magic-jev.vercel.app/api/ask/ ')).toEqual({ origin: 'https://magic-jev.vercel.app' });
  });

  it('accepts http only on this machine', () => {
    expect(serverOrigin('http://localhost:3000')).toEqual({ origin: 'http://localhost:3000' });
    expect(serverOrigin('http://127.0.0.1:3000/')).toEqual({ origin: 'http://127.0.0.1:3000' });
  });

  it('refuses plain http anywhere else, because the passphrase would travel in the clear', () => {
    expect(serverOrigin('http://magic-jev.vercel.app')).toHaveProperty('problem');
    expect(serverOrigin('ftp://magic-jev.vercel.app')).toHaveProperty('problem');
  });

  it('refuses a value that is not a URL', () => {
    expect(serverOrigin('magic-jev.vercel.app')).toHaveProperty('problem');
  });
});

describe('ask', () => {
  it('sends the passphrase to the given origin and refuses to follow a redirect with it', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, verdict: 'yes', latencyMs: 200 }));
    }) as typeof fetch;

    const outcome = await ask('https://magic-jev.vercel.app', 'open sesame', { kind: 'pr', signals: buildCases()[0]!.signals }, fetchFn);

    expect(outcome).toEqual({ kind: 'answer', verdict: 'yes', latencyMs: 200 });
    expect(calls[0]?.url).toBe('https://magic-jev.vercel.app/api/ask');
    expect(new Headers(calls[0]?.init?.headers).get(PASSPHRASE_HEADER)).toBe('open sesame');
    expect(calls[0]?.init?.redirect).toBe('error');
  });
});
