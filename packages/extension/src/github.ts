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
/** 10 pages of 100 covers 1000 files or reviews. Past that the size signal has already decided the verdict. */
const MAX_PAGES = 10;
const REVIEW_REQUEST_QUERY = 'is:open is:pr review-requested:@me archived:false';

/**
 * A non-2xx answer from GitHub. The message holds the status only, never the
 * response text or the token, so it is safe to log.
 */
export class GitHubError extends Error {
  status: number;

  constructor(status: number) {
    super(`GitHub answered ${status}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

async function getJson(path: string, token: string, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(`${API}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    // The token is the only credential. Never send github.com cookies with it.
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new GitHubError(response.status);
  return response.json();
}

/** Reads a list endpoint page by page until a short page, or MAX_PAGES. */
async function getAllPages(path: string, token: string, fetchFn: typeof fetch): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await getJson(`${path}?per_page=${PAGE_SIZE}&page=${page}`, token, fetchFn);
    if (!Array.isArray(body)) throw new Error('GitHub sent something other than a list');
    items.push(...body);
    if (body.length < PAGE_SIZE) break;
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

  const [files, reviews, status, checks] = await Promise.all([
    getAllPages(`${pullPath}/files`, token, fetchFn),
    getAllPages(`${pullPath}/reviews`, token, fetchFn),
    getJson(`${commitPath}/status?per_page=${PAGE_SIZE}`, token, fetchFn),
    getJson(`${commitPath}/check-runs?per_page=${PAGE_SIZE}`, token, fetchFn),
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
    checkRuns: list(record(checks).check_runs).map((run) => {
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
export function githubFailureReason(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 401) return 'GitHub token rejected';
    if (error.status === 403 || error.status === 429) return 'GitHub rate limit reached';
    if (error.status === 404) return 'GitHub cannot see this pull request';
    return `GitHub answered ${error.status}`;
  }
  // fetch rejects with a TypeError when the network fails, and a DOMException when aborted.
  if (error instanceof TypeError || error instanceof DOMException) return 'could not reach GitHub';
  return 'GitHub gave an unexpected answer';
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
      headers: { 'content-type': 'application/json', [PASSPHRASE_HEADER]: server.passphrase },
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
      return { ok: false, reason: 'Jev is rate limited' };
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
