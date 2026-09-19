import { describe, expect, it } from 'vitest';
import { PASSPHRASE_HEADER, buildPrSignals, type PrSignals } from '../../core/src/index.js';
import {
  GitHubError,
  askServer,
  fetchLogin,
  fetchPull,
  fetchRawPr,
  githubFailureReason,
  searchReviewRequests,
} from './github.js';
import type { PrRef } from './messages.js';

const REF: PrRef = { owner: 'octo', repo: 'hello', number: 12 };
const TOKEN = 'ghp_test_token';
const PULL_URL = 'https://api.github.com/repos/octo/hello/pulls/12';
const SHA = 'abc123';

/** The pull as GitHub sends it: the fields the contract reads, plus noise that must be dropped. */
const PULL_PAYLOAD = {
  id: 99,
  title: 'Add a thing',
  draft: false,
  additions: 30,
  deletions: 12,
  changed_files: 2,
  user: { login: 'octocat', type: 'User', id: 1 },
  requested_reviewers: [{ login: 'me', id: 2 }],
  head: { sha: SHA, ref: 'feature' },
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

type Route = (url: URL) => { status?: number; body: unknown } | undefined;

/** A fetch that answers from `route` and records every request. No network. */
function fakeFetch(route: Route): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const answer = route(new URL(url));
    if (!answer) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const many = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => ({ filename: `${prefix}/file-${i}.ts` }));

/** Routes for a small green pull request. `overrides` runs first and may answer any URL itself. */
function prRoutes(overrides: Route = () => undefined): Route {
  return (url) => {
    const special = overrides(url);
    if (special) return special;
    const path = url.pathname;
    if (path === '/repos/octo/hello/pulls/12') return { body: PULL_PAYLOAD };
    if (path === '/repos/octo/hello/pulls/12/files') return { body: [{ filename: 'src/app.ts', sha: 'f1' }] };
    if (path === '/repos/octo/hello/pulls/12/reviews') {
      return { body: [{ id: 5, user: { login: 'rev', id: 3 }, state: 'APPROVED' }, { id: 6, user: null, state: 'COMMENTED' }] };
    }
    if (path === `/repos/octo/hello/commits/${SHA}/status`) {
      return { body: { state: 'success', total_count: 1, statuses: [{}] } };
    }
    if (path === `/repos/octo/hello/commits/${SHA}/check-runs`) {
      return { body: { total_count: 1, check_runs: [{ id: 7, status: 'completed', conclusion: 'success' }] } };
    }
    return undefined;
  };
}

describe('fetchRawPr', () => {
  it('gets the pull first, then files, reviews, the combined status and the check runs for the head sha', async () => {
    const { fetchFn, calls } = fakeFetch(prRoutes());
    await fetchRawPr(REF, TOKEN, fetchFn);

    expect(calls[0]?.url).toBe(PULL_URL);
    expect(calls.slice(1).map((call) => call.url).sort()).toEqual(
      [
        `${PULL_URL}/files?per_page=100&page=1`,
        `${PULL_URL}/reviews?per_page=100&page=1`,
        `https://api.github.com/repos/octo/hello/commits/${SHA}/status?per_page=100`,
        `https://api.github.com/repos/octo/hello/commits/${SHA}/check-runs?per_page=100&page=1`,
      ].sort(),
    );
    expect(calls).toHaveLength(5);
  });

  it('sends the token and the GitHub API headers on every request', async () => {
    const { fetchFn, calls } = fakeFetch(prRoutes());
    await fetchRawPr(REF, TOKEN, fetchFn);

    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get('accept')).toBe('application/vnd.github+json');
      expect(call.headers.get('x-github-api-version')).toBe('2022-11-28');
    }
  });

  it('returns the payloads trimmed to the contract, with check_runs unwrapped', async () => {
    const { fetchFn } = fakeFetch(prRoutes());
    const raw = await fetchRawPr(REF, TOKEN, fetchFn);

    expect(raw).toEqual({
      pull: {
        draft: false,
        additions: 30,
        deletions: 12,
        changed_files: 2,
        user: { login: 'octocat', type: 'User' },
        requested_reviewers: [{ login: 'me' }],
        head: { sha: SHA },
      },
      files: [{ filename: 'src/app.ts' }],
      reviews: [
        { user: { login: 'rev' }, state: 'APPROVED' },
        { user: null, state: 'COMMENTED' },
      ],
      combinedStatus: { state: 'success', total_count: 1 },
      checkRuns: [{ status: 'completed', conclusion: 'success' }],
    });
  });

  it('follows pagination and stops on a short page', async () => {
    const { fetchFn, calls } = fakeFetch(
      prRoutes((url) => {
        if (!url.pathname.endsWith('/files')) return undefined;
        const page = Number(url.searchParams.get('page'));
        return { body: page === 1 ? many(100, 'a') : many(3, 'b') };
      }),
    );
    const raw = await fetchRawPr(REF, TOKEN, fetchFn);

    const filePages = calls.filter((call) => call.url.includes('/files?')).map((call) => call.url);
    expect(filePages).toEqual([`${PULL_URL}/files?per_page=100&page=1`, `${PULL_URL}/files?per_page=100&page=2`]);
    expect(raw.files).toHaveLength(103);
    expect(raw.files[100]).toEqual({ filename: 'b/file-0.ts' });
    // Reviews fit on one short page, so they are asked for once.
    expect(calls.filter((call) => call.url.includes('/reviews?'))).toHaveLength(1);
  });

  it('stops after 10 pages even when every page is full', async () => {
    const { fetchFn, calls } = fakeFetch(
      prRoutes((url) => (url.pathname.endsWith('/files') ? { body: many(100, 'a') } : undefined)),
    );
    const raw = await fetchRawPr(REF, TOKEN, fetchFn);

    expect(calls.filter((call) => call.url.includes('/files?'))).toHaveLength(10);
    expect(raw.files).toHaveLength(1000);
  });

  it('reads every page of check runs, so a failure past the first 100 still counts', async () => {
    const green = { status: 'completed', conclusion: 'success' };
    const { fetchFn, calls } = fakeFetch(
      prRoutes((url) => {
        if (!url.pathname.endsWith('/check-runs')) return undefined;
        const page = Number(url.searchParams.get('page'));
        const runs =
          page === 1
            ? Array.from({ length: 100 }, () => green)
            : [...Array.from({ length: 49 }, () => green), { status: 'completed', conclusion: 'failure' }];
        return { body: { total_count: 150, check_runs: runs } };
      }),
    );
    const raw = await fetchRawPr(REF, TOKEN, fetchFn);

    const checkPages = calls.filter((call) => call.url.includes('/check-runs?')).map((call) => call.url);
    const checksUrl = `https://api.github.com/repos/octo/hello/commits/${SHA}/check-runs`;
    expect(checkPages).toEqual([`${checksUrl}?per_page=100&page=1`, `${checksUrl}?per_page=100&page=2`]);
    expect(raw.checkRuns).toHaveLength(150);
    expect(buildPrSignals(raw).ci).toBe('failing');
  });

  it('stops asking for check runs after 10 full pages', async () => {
    const { fetchFn, calls } = fakeFetch(
      prRoutes((url) =>
        url.pathname.endsWith('/check-runs')
          ? { body: { total_count: 5000, check_runs: Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' })) } }
          : undefined,
      ),
    );
    const raw = await fetchRawPr(REF, TOKEN, fetchFn);

    expect(calls.filter((call) => call.url.includes('/check-runs?'))).toHaveLength(10);
    expect(raw.checkRuns).toHaveLength(1000);
  });

  it('throws GitHubError with the status when the pull is refused, and asks for nothing else', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));

    const error = await fetchRawPr(REF, TOKEN, fetchFn).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('throws GitHubError when one of the parallel requests fails', async () => {
    const { fetchFn } = fakeFetch(
      prRoutes((url) => (url.pathname.endsWith('/check-runs') ? { status: 403, body: { message: 'Forbidden' } } : undefined)),
    );

    await expect(fetchRawPr(REF, TOKEN, fetchFn)).rejects.toMatchObject({ name: 'GitHubError', status: 403 });
  });

  it('never puts the token or the response text in the error message', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 401, body: { message: 'Bad credentials for secret-detail' } }));

    const error = (await fetchRawPr(REF, TOKEN, fetchFn).catch((caught: unknown) => caught)) as GitHubError;
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('secret-detail');
  });

  it('encodes the owner and repo in the path', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 404, body: {} }));
    await fetchRawPr({ owner: 'a/b', repo: 'c?d', number: 3 }, TOKEN, fetchFn).catch(() => undefined);

    expect(calls[0]?.url).toBe('https://api.github.com/repos/a%2Fb/c%3Fd/pulls/3');
  });
});

describe('fetchPull', () => {
  it('gets only the pull, trimmed to the contract', async () => {
    const { fetchFn, calls } = fakeFetch(prRoutes());
    const pull = await fetchPull(REF, TOKEN, fetchFn);

    expect(calls.map((call) => call.url)).toEqual([PULL_URL]);
    expect(pull.requested_reviewers).toEqual([{ login: 'me' }]);
    expect(pull.head).toEqual({ sha: SHA });
  });
});

describe('fetchLogin', () => {
  it('asks /user and returns the login', async () => {
    const { fetchFn, calls } = fakeFetch((url) => (url.pathname === '/user' ? { body: { login: 'me', id: 2 } } : undefined));

    expect(await fetchLogin(TOKEN, fetchFn)).toBe('me');
    expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/user']);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('throws GitHubError with status 401 for a rejected token', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));

    await expect(fetchLogin(TOKEN, fetchFn)).rejects.toMatchObject({ name: 'GitHubError', status: 401 });
  });
});

describe('searchReviewRequests', () => {
  it('asks for requests made to the user directly, not to a team, URL-encoded, with per_page=50', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { total_count: 0, items: [] } }));
    await searchReviewRequests(TOKEN, fetchFn);

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/search/issues?q=is%3Aopen%20is%3Apr%20user-review-requested%3A%40me%20archived%3Afalse&per_page=50',
    ]);
    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('is:open is:pr user-review-requested:@me archived:false');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('maps each item to id, title and htmlUrl', async () => {
    const { fetchFn } = fakeFetch(() => ({
      body: {
        total_count: 2,
        items: [
          { id: 101, number: 12, title: 'Add a thing', html_url: 'https://github.com/octo/hello/pull/12', state: 'open' },
          { id: 102, number: 7, title: 'Fix a thing', html_url: 'https://github.com/octo/other/pull/7', state: 'open' },
        ],
      },
    }));

    expect(await searchReviewRequests(TOKEN, fetchFn)).toEqual([
      { id: 101, title: 'Add a thing', htmlUrl: 'https://github.com/octo/hello/pull/12' },
      { id: 102, title: 'Fix a thing', htmlUrl: 'https://github.com/octo/other/pull/7' },
    ]);
  });

  it('throws GitHubError with status 403 when the search is rate limited', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 403, body: { message: 'rate limit' } }));

    await expect(searchReviewRequests(TOKEN, fetchFn)).rejects.toMatchObject({ name: 'GitHubError', status: 403 });
  });
});

describe('githubFailureReason', () => {
  it('names each GitHub failure in plain words', () => {
    expect(githubFailureReason(new GitHubError(401))).toBe('GitHub token rejected');
    expect(githubFailureReason(new GitHubError(429))).toBe('GitHub rate limit reached');
    expect(githubFailureReason(new GitHubError(500))).toBe('GitHub answered 500');
  });

  it('says which part of the pull request the token could not read', () => {
    // GitHub answers 404 for a private repository the token does not cover, and 403 or 404 for a
    // resource the token lacks the permission for. "Rate limit" is only said when GitHub says so.
    expect(githubFailureReason(new GitHubError(404, 'pull request'))).toBe('this token cannot see this repository');
    expect(githubFailureReason(new GitHubError(404, 'checks'))).toBe('this token cannot read the checks');
    expect(githubFailureReason(new GitHubError(403, 'checks'))).toBe('this token cannot read the checks');
    expect(githubFailureReason(new GitHubError(403, 'commit status'))).toBe('this token cannot read the commit status');
    expect(githubFailureReason(new GitHubError(403, 'checks', true))).toBe('GitHub rate limit reached');
    expect(githubFailureReason(new GitHubError(404))).toBe('this token cannot see this repository');
  });

  it('labels a failed request by the resource it asked for', async () => {
    const failing = (failOn: string) =>
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(failOn)) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '4990' } });
        if (url.includes('/check-runs')) return Response.json({ total_count: 0, check_runs: [] });
        if (url.endsWith('/status')) return Response.json({ state: 'pending', total_count: 0 });
        if (/\/pulls\/\d+$/.test(url.split('?')[0])) {
          return Response.json({ draft: false, additions: 1, deletions: 0, changed_files: 1, user: { login: 'a', type: 'User' }, requested_reviewers: [], head: { sha: 'abc' } });
        }
        return Response.json([]);
      }) as typeof fetch;
    const ref = { owner: 'o', repo: 'r', number: 1 };
    await expect(fetchRawPr(ref, TOKEN, failing('/check-runs'))).rejects.toMatchObject({ status: 403, what: 'checks', rateLimited: false });
    await expect(fetchRawPr(ref, TOKEN, failing('/status'))).rejects.toMatchObject({ what: 'commit status' });
    await expect(fetchRawPr(ref, TOKEN, failing('/reviews'))).rejects.toMatchObject({ what: 'reviews' });
    await expect(fetchRawPr(ref, TOKEN, failing('/pulls/1'))).rejects.toMatchObject({ what: 'pull request' });
  });

  it('calls a 403 a rate limit only when GitHub says none are left', async () => {
    const limited = (async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as typeof fetch;
    await expect(fetchLogin(TOKEN, limited)).rejects.toMatchObject({ status: 403, rateLimited: true });
  });

  it('says GitHub could not be reached when fetch itself threw', () => {
    expect(githubFailureReason(new TypeError('Failed to fetch'))).toBe('could not reach GitHub');
  });

  it('never repeats an unknown error message', () => {
    expect(githubFailureReason(new Error('secret-detail'))).toBe('GitHub gave an unexpected answer');
  });
});

describe('askServer', () => {
  const SIGNALS: PrSignals = {
    ci: 'passing',
    linesChanged: 42,
    filesChanged: 2,
    docsOnly: false,
    testsTouched: true,
    approvals: 1,
    changesRequested: 0,
    isDraft: false,
    authorIsBot: false,
  };
  const SERVER = { serverUrl: 'https://magic-jev.vercel.app', passphrase: 'open sesame' };

  /** A server that always answers with this status and JSON body, and records what it was sent. */
  function fakeServer(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it('posts the signals as an AskRequest with the passphrase header', async () => {
    const { fetchFn, calls } = fakeServer(200, { ok: true, verdict: 'yes', latencyMs: 250 });
    await askServer(SERVER, SIGNALS, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://magic-jev.vercel.app/api/ask');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get(PASSPHRASE_HEADER)).toBe('open sesame');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: 'pr', signals: SIGNALS });
  });

  it('replies with the verdict, the signals it sent and the latency', async () => {
    const { fetchFn } = fakeServer(200, { ok: true, verdict: 'lean_yes', latencyMs: 312 });

    expect(await askServer(SERVER, SIGNALS, fetchFn)).toEqual({ ok: true, verdict: 'lean_yes', signals: SIGNALS, latencyMs: 312 });
  });

  it('names each server failure in plain words', async () => {
    const cases: Array<[number, string, string, string]> = [
      [401, 'unauthorized', 'Wrong or missing passphrase.', 'server passphrase rejected'],
      [402, 'out_of_credits', 'No credits.', 'out of Gateway credits'],
      [429, 'rate_limited', 'Slow down.', 'too many asks, try again in a minute'],
      [502, 'model_error', 'Jev did not answer in time.', 'Jev did not answer in time'],
      [502, 'model_error', 'The model call failed.', 'The model call failed'],
      [400, 'bad_request', 'signals.ci: bad value', 'the server refused the request'],
    ];
    for (const [status, error, message, reason] of cases) {
      const { fetchFn } = fakeServer(status, { ok: false, error, message });
      expect(await askServer(SERVER, SIGNALS, fetchFn)).toEqual({ ok: false, reason });
    }
  });

  it('says the server could not be reached when fetch throws', async () => {
    const fetchFn = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    expect(await askServer(SERVER, SIGNALS, fetchFn)).toEqual({ ok: false, reason: 'could not reach the server' });
  });

  it('does not trust an answer that is not an AskResponse', async () => {
    const unexpected = { ok: false, reason: 'the server gave an unexpected answer' };

    expect(await askServer(SERVER, SIGNALS, fakeServer(404, '<html>Not found</html>').fetchFn)).toEqual(unexpected);
    expect(await askServer(SERVER, SIGNALS, fakeServer(200, { ok: true, verdict: 'maybe', latencyMs: 1 }).fetchFn)).toEqual(unexpected);
    expect(await askServer(SERVER, SIGNALS, fakeServer(500, { ok: false, error: 'surprise', message: 'secret-detail' }).fetchFn)).toEqual(unexpected);
  });
});
