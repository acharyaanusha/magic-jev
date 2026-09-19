import { describe, expect, it } from 'vitest';
import { GitHubError, askServer, fetchRawPr, githubFailureReason, needsToken } from './github.js';
import { DEFAULT_SETTINGS, HOSTED_SERVER_URL } from './messages.js';
import type { PrSignals } from '../../core/src/index.js';

const SIGNALS: PrSignals = {
  ci: 'passing', linesChanged: 12, filesChanged: 1, docsOnly: false, testsTouched: true,
  approvals: 0, changesRequested: 0, isDraft: false, authorIsBot: false,
};

function githubStub(seen: Array<{ url: string; headers: Headers }>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url.includes('/check-runs')) return Response.json({ total_count: 0, check_runs: [] });
    if (url.endsWith('/status')) return Response.json({ state: 'pending', total_count: 0 });
    if (/\/pulls\/\d+$/.test(url.split('?')[0])) {
      return Response.json({ draft: false, additions: 1, deletions: 0, changed_files: 0, user: { login: 'a', type: 'User' }, requested_reviewers: [], head: { sha: 'abc' } });
    }
    return Response.json([]);
  }) as typeof fetch;
}

describe('without a GitHub token', () => {
  it('reads a public pull request with no Authorization header at all', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    await fetchRawPr({ owner: 'o', repo: 'r', number: 1 }, '', githubStub(seen));
    expect(seen.length).toBe(5);
    for (const request of seen) expect(request.headers.has('authorization')).toBe(false);
  });

  it('still sends the token when there is one', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    await fetchRawPr({ owner: 'o', repo: 'r', number: 1 }, 'ghp_x', githubStub(seen));
    expect(seen[0].headers.get('authorization')).toBe('Bearer ghp_x');
  });

  it('explains a private pull request and a used-up anonymous limit as things a token fixes', () => {
    const notFound = new GitHubError(404, 'pull request');
    const limited = new GitHubError(403, 'pull request', true);
    expect(githubFailureReason(notFound, false)).toBe('this pull request is private: add a GitHub token');
    expect(githubFailureReason(limited, false)).toBe("GitHub's hourly limit without a token is used up: add one");
    expect(needsToken(notFound, false)).toBe(true);
    expect(needsToken(limited, false)).toBe(true);
    // With a token the same failures keep their old wording, and adding a token is not the fix.
    expect(githubFailureReason(notFound, true)).toBe('this token cannot see this repository');
    expect(githubFailureReason(limited, true)).toBe('GitHub rate limit reached');
    expect(needsToken(notFound, true)).toBe(false);
    expect(needsToken(new GitHubError(500), false)).toBe(false);
  });
});

describe('the hosted server', () => {
  it('is the default, so a fresh install needs no setup', () => {
    expect(HOSTED_SERVER_URL).toBe('https://magic-jev.vercel.app');
    expect(DEFAULT_SETTINGS.serverUrl).toBe(HOSTED_SERVER_URL);
    expect(DEFAULT_SETTINGS.githubToken).toBe('');
    expect(DEFAULT_SETTINGS.passphrase).toBe('');
  });

  it('gets no passphrase header when there is no passphrase', async () => {
    let headers = new Headers();
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ ok: true, verdict: 'yes', latencyMs: 200 });
    }) as typeof fetch;
    const reply = await askServer({ serverUrl: HOSTED_SERVER_URL, passphrase: '' }, SIGNALS, fetchFn);
    expect(reply.ok).toBe(true);
    expect(headers.has('x-magic-jev-key')).toBe(false);
  });

  it('says so when the shared server is turning this caller away', async () => {
    const fetchFn = (async () =>
      Response.json({ ok: false, error: 'rate_limited', message: 'Too many asks. Try again in a minute.' }, { status: 429 })) as typeof fetch;
    const reply = await askServer({ serverUrl: HOSTED_SERVER_URL, passphrase: '' }, SIGNALS, fetchFn);
    expect(reply).toEqual({ ok: false, reason: 'too many asks, try again in a minute' });
  });
});
