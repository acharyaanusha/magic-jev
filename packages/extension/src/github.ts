/**
 * The extension's network calls: the GitHub REST API, and the one POST to our
 * own server. Only the background worker and the options page's Test button
 * use this file, so the token and the passphrase never reach a content script.
 * Every function takes an injectable fetch, which is how the tests run without
 * a network.
 */
import { PASSPHRASE_HEADER, VERDICTS, type AskRequest, type PrSignals, type RawPr, type Verdict } from '../../core/src/index.js';
import type { AskReply, PrRef, Settings } from './messages.js';

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
/**
 * 10 pages of 100 covers 1000 files, reviews or check runs. A file list cut
 * short here is never called docs-only (buildPrSignals compares it with
 * changed_files), so the size signal decides the verdict for such a pull request.
 */
const MAX_PAGES = 10;
/**
 * `user-review-requested` leaves out requests made to a team the user is on.
 * The ball is only drawn when the user is named in requested_reviewers, so a
 * notification for a team request would open a page with no ball on it.
 */
const REVIEW_REQUEST_QUERY = 'is:open is:pr user-review-requested:@me archived:false';

/**
 * A non-2xx answer from GitHub. The message holds the status only, never the
 * response text or the token, so it is safe to log.
 */
/** Which part of GitHub a request asked for, in the words the ball uses. */
export type GitHubResource = 'pull request' | 'files' | 'reviews' | 'commit status' | 'checks' | 'account' | 'search';

export class GitHubError extends Error {
  status: number;
  /** What was being read when GitHub refused. Unset when the caller does not know. */
  what: GitHubResource | undefined;
  /** GitHub said no requests are left, which is the only time a 403 means a rate limit. */
  rateLimited: boolean;

  constructor(status: number, what?: GitHubResource, rateLimited = false) {
    super(`GitHub answered ${status}${what ? ` for the ${what}` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
    this.what = what;
    this.rateLimited = rateLimited;
  }
}

function resourceOf(path: string): GitHubResource {
  const bare = path.split('?')[0];
  if (bare.endsWith('/check-runs')) return 'checks';
  if (bare.endsWith('/status')) return 'commit status';
  if (bare.endsWith('/files')) return 'files';
  if (bare.endsWith('/reviews')) return 'reviews';
  if (bare.startsWith('/search/')) return 'search';
  if (bare === '/user') return 'account';
  return 'pull request';
}

async function getJson(path: string, token: string, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(`${API}${path}`, {
    method: 'GET',
    headers: {
      // No token is fine for public repositories, within GitHub's hourly limit for anonymous requests.
      ...(token !== '' && { Authorization: `Bearer ${token}` }),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    // The token is the only credential. Never send github.com cookies with it.
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) {
    const rateLimited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0';
    throw new GitHubError(response.status, resourceOf(path), rateLimited);
  }
  return response.json();
}

/**
 * Reads a list endpoint page by page until a short page, or MAX_PAGES. Most
 * endpoints answer with the list itself; `listKey` names the field that holds
 * it for the ones that wrap it in an object (check runs).
 */
async function getAllPages(path: string, token: string, fetchFn: typeof fetch, listKey?: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await getJson(`${path}?per_page=${PAGE_SIZE}&page=${page}`, token, fetchFn);
    const pageItems = listKey === undefined ? body : record(body)[listKey];
    if (!Array.isArray(pageItems)) throw new Error('GitHub sent something other than a list');
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) break;
  }
  return items;
}

/** The payloads are JSON we did not write. These read a field without trusting its type. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function repoPath(ref: PrRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

/** Keeps only the fields in the RawPr contract, so nothing else from the payload travels further. */
function trimPull(body: unknown): RawPr['pull'] {
  const pull = record(body);
  const user = record(pull.user);
  const sha = text(record(pull.head).sha);
  if (sha === '') throw new Error('GitHub sent a pull request without a head commit');
  return {
    draft: pull.draft === true,
    additions: count(pull.additions),
    deletions: count(pull.deletions),
    changed_files: count(pull.changed_files),
    user: { login: text(user.login), type: text(user.type) },
    requested_reviewers: list(pull.requested_reviewers).map((reviewer) => ({ login: text(record(reviewer).login) })),
    head: { sha },
  };
}

/** The pull alone. Enough to tell whether the user is a requested reviewer. */
export async function fetchPull(ref: PrRef, token: string, fetchFn: typeof fetch = fetch): Promise<RawPr['pull']> {
  return trimPull(await getJson(`${repoPath(ref)}/pulls/${ref.number}`, token, fetchFn));
}

/** Everything buildPrSignals needs: the pull first (for the head sha), then the other four in parallel. */
export async function fetchRawPr(ref: PrRef, token: string, fetchFn: typeof fetch = fetch): Promise<RawPr> {
  const pull = await fetchPull(ref, token, fetchFn);
  const pullPath = `${repoPath(ref)}/pulls/${ref.number}`;
  const commitPath = `${repoPath(ref)}/commits/${encodeURIComponent(pull.head.sha)}`;

  // Check runs are paged like files and reviews: one failed or running job past
  // the first 100 (a large build matrix) must still count.
  const [files, reviews, status, checkRuns] = await Promise.all([
    getAllPages(`${pullPath}/files`, token, fetchFn),
    getAllPages(`${pullPath}/reviews`, token, fetchFn),
    getJson(`${commitPath}/status?per_page=${PAGE_SIZE}`, token, fetchFn),
    getAllPages(`${commitPath}/check-runs`, token, fetchFn, 'check_runs'),
  ]);

  const combined = record(status);
  return {
    pull,
    files: files.map((file) => ({ filename: text(record(file).filename) })),
    reviews: reviews.map((review) => {
      const { user, state } = record(review);
      return { user: user === null || user === undefined ? null : { login: text(record(user).login) }, state: text(state) };
    }),
    combinedStatus: { state: text(combined.state), total_count: count(combined.total_count) },
    checkRuns: checkRuns.map((run) => {
      const { status: runStatus, conclusion } = record(run);
      return { status: text(runStatus), conclusion: typeof conclusion === 'string' ? conclusion : null };
    }),
  };
}

/** The login the token belongs to. */
export async function fetchLogin(token: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const login = text(record(await getJson('/user', token, fetchFn)).login);
  if (login === '') throw new Error('GitHub did not say who the token belongs to');
  return login;
}

/** Open pull requests that ask for the user's review, newest 50. */
export async function searchReviewRequests(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ id: number; title: string; htmlUrl: string }>> {
  const body = await getJson(`/search/issues?q=${encodeURIComponent(REVIEW_REQUEST_QUERY)}&per_page=50`, token, fetchFn);
  return list(record(body).items).map((item) => {
    const { id, title, html_url: htmlUrl } = record(item);
    return { id: count(id), title: text(title), htmlUrl: text(htmlUrl) };
  });
}

/** The line shown under "Reply hazy, try again" when a GitHub call fails. Never repeats an error's own text. */
export function githubFailureReason(error: unknown, hasToken = true): string {
  if (error instanceof GitHubError) {
    if (needsToken(error, hasToken)) {
      return error.rateLimited
        ? "GitHub's hourly limit without a token is used up: add one"
        : 'this pull request is private: add a GitHub token';
    }
    if (error.status === 401) return 'GitHub token rejected';
    if (error.rateLimited || error.status === 429) return 'GitHub rate limit reached';
    if (error.status === 403 || error.status === 404) {
      // A 404 on the pull request itself is a repository the token does not cover. GitHub hides
      // private repositories that way. On any other part it is a permission the token lacks.
      if (error.what === undefined || error.what === 'pull request') return 'this token cannot see this repository';
      return `this token cannot read the ${error.what}`;
    }
    return `GitHub answered ${error.status}`;
  }
  // fetch rejects with a TypeError when the network fails, and a DOMException when aborted.
  if (error instanceof TypeError || error instanceof DOMException) return 'could not reach GitHub';
  return 'GitHub gave an unexpected answer';
}

/** True when there is no token and adding one is the fix: a private repository, or the anonymous limit used up. */
export function needsToken(error: unknown, hasToken: boolean): boolean {
  if (hasToken || !(error instanceof GitHubError)) return false;
  return error.rateLimited || error.status === 403 || error.status === 404;
}

/** The server answers within about 5 seconds or gives up itself. Past this the ball should stop shaking anyway. */
const SERVER_TIMEOUT_MS = 12_000;
const UNEXPECTED_SERVER_ANSWER = 'the server gave an unexpected answer';

const isVerdict = (value: unknown): value is Verdict => (VERDICTS as readonly unknown[]).includes(value);

/**
 * Asks the server for a verdict on these signals. Never throws: a failure
 * comes back as `{ ok: false, reason }` in plain words, because the ball must
 * always land on an answer.
 */
export async function askServer(
  server: Pick<Settings, 'serverUrl' | 'passphrase'>,
  signals: PrSignals,
  fetchFn: typeof fetch = fetch,
): Promise<AskReply> {
  const request: AskRequest = { kind: 'pr', signals };
  let response: Response;
  try {
    response = await fetchFn(`${server.serverUrl}/api/ask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.passphrase !== '' && { [PASSPHRASE_HEADER]: server.passphrase }),
      },
      body: JSON.stringify(request),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'could not reach the server' };
  }

  let body: Record<string, unknown>;
  try {
    body = record(await response.json());
  } catch {
    // Not JSON: most likely the URL points at something that is not our server.
    return { ok: false, reason: UNEXPECTED_SERVER_ANSWER };
  }

  if (response.ok && body.ok === true && isVerdict(body.verdict)) {
    return { ok: true, verdict: body.verdict, signals, latencyMs: Math.round(count(body.latencyMs)) };
  }
  if (body.ok !== false) return { ok: false, reason: UNEXPECTED_SERVER_ANSWER };

  switch (body.error) {
    case 'unauthorized':
      return { ok: false, reason: 'server passphrase rejected' };
    case 'out_of_credits':
      return { ok: false, reason: 'out of Gateway credits' };
    case 'rate_limited':
      // Either the shared server's own limit or the Gateway's. The cure is the same.
      return { ok: false, reason: 'too many asks, try again in a minute' };
    case 'bad_request':
      return { ok: false, reason: 'the server refused the request' };
    case 'model_error': {
      // The server's own fixed sentence, without its full stop. Capped in case the URL is not our server.
      const message = text(body.message).replace(/\.\s*$/, '').slice(0, 80);
      return { ok: false, reason: message === '' ? 'the model call failed' : message };
    }
    default:
      return { ok: false, reason: UNEXPECTED_SERVER_ANSWER };
  }
}
