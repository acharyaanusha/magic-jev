# Magic Jev Phase 1 Implementation Plan

> **For agentic workers:** this plan is executed by a Workflow (the user's choice), one agent per task, then a review pass. Each task owns the files it lists and touches no others. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension that shows a Magic 8 Ball on GitHub pull requests awaiting the user's review and answers "should I approve this?" from real PR signals, decided by Jev.

**Architecture:** One repo, one `package.json`, three source folders. `packages/core` is pure logic (signals, criteria, the local rule, phrases). `packages/server` is the request handler behind `api/ask.ts`, a Vercel function that asks Jev. `packages/extension` is a Manifest V3 extension whose background worker owns every network call. Spec: `docs/superpowers/specs/2026-09-18-magic-jev-design.md`.

**Tech Stack:** TypeScript 5.9, Node 22, `ai` 7 (`experimental_evaluate`, model `typesafe-ai/jev` via Vercel AI Gateway), zod 4, vitest 5, esbuild, Chrome MV3.

**Two deliberate simplifications of the spec:** a single package instead of a pnpm workspace (relative imports deploy to Vercel without a build step), and one extra option, `showOnEveryPr`, so the ball can be demoed on any pull request.

---

## Ground rules for every task

- `pnpm` is not on PATH. Run it as `corepack pnpm ...` (`corepack pnpm test`, `corepack pnpm typecheck`).
- Every relative import ends in `.js` and resolves to the `.ts` file: `import { x } from './signals.js'`. Node ESM on Vercel needs this; vitest, tsx and esbuild accept it.
- The contracts already exist and are not to be changed: `packages/core/src/types.ts` and `packages/extension/src/messages.ts`. If one looks wrong, say so in your report instead of editing it.
- Do not add dependencies. Do not run `vercel`, `gh`, or anything that touches an account. No network calls in tests.
- TDD: write the failing test, watch it fail, implement, watch it pass. Commit at the end of the task with `git add <your files>` (never `git add -A`; other agents are working in this repo at the same time).
- Comments say what and why, in plain sentences. No em dashes.

## File map

| File | Owner | Responsibility |
|---|---|---|
| `packages/core/src/types.ts` | done | shared types (exists) |
| `packages/core/src/signals.ts` | Task 1 | `buildPrSignals(raw)` |
| `packages/core/src/criteria.ts` | Task 1 | `PR_INSTRUCTIONS`, `PR_CRITERIA`, `PR_QUESTIONS`, `expectedVerdict(signals)` |
| `packages/core/src/phrases.ts` | Task 1 | `PHRASES`, `pickPhrase(verdict, rng?)`, `HAZY` |
| `packages/core/src/reason.ts` | Task 1 | `reasonFor(signals, verdict)` |
| `packages/core/src/index.ts` | Task 1 | re-exports everything above and `types.ts` |
| `packages/server/src/handler.ts` | Task 2 | `handleAsk(request, deps?)` |
| `api/ask.ts` | Task 2 | `export const POST`, the Vercel entry |
| `scripts/verify-criteria.ts` | Task 2 | the live check |
| `packages/extension/src/messages.ts` | done | message and settings types (exists) |
| `packages/extension/src/github.ts` | Task 3 | GitHub REST calls |
| `packages/extension/src/settings.ts` | Task 3 | read and write `Settings` in `chrome.storage.local` |
| `packages/extension/src/background.ts` | Task 3 | alarms, polling, notifications, message handling |
| `packages/extension/src/options.ts`, `static/options.html` | Task 3 | options page |
| `packages/extension/src/pr-url.ts` | Task 4 | `parsePrUrl(pathname)` |
| `packages/extension/src/ball.ts` | Task 4 | the ball UI in a shadow root |
| `packages/extension/src/content.ts` | Task 4 | wires URL changes, the worker and the ball |
| `packages/extension/static/icon-128.png` | Task 4 | the icon |
| `packages/extension/static/manifest.json`, `build.mjs` | done | exist |

---

### Task 1: core

**Files:** create `packages/core/src/{signals,criteria,phrases,reason,index}.ts` and a `.test.ts` beside each of the first four.

**Exports, exactly:**

```ts
// signals.ts
export function buildPrSignals(raw: RawPr): PrSignals;
// criteria.ts
export const PR_INSTRUCTIONS: string;
export const PR_CRITERIA: Record<Verdict, string>;
export const PR_QUESTIONS: { verdict: { type: 'choice'; instructions: string; criteria: Record<Verdict, string> } };
export function expectedVerdict(signals: PrSignals): Verdict;
// phrases.ts
export const PHRASES: Record<Verdict, readonly string[]>;   // 5 each, the wording in the spec
export const HAZY: string;                                   // 'Reply hazy, try again'
export function pickPhrase(verdict: Verdict, rng?: () => number): string; // rng defaults to Math.random
// reason.ts
export function reasonFor(signals: PrSignals, verdict: Verdict): string;
```

- [ ] **signals.** `ci`: any check run with `conclusion` in `failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`, or a combined status `state` of `failure` or `error`, is `failing`. Otherwise any check run whose `status` is not `completed`, or a combined status `state` of `pending` with `total_count > 0`, is `pending`. Otherwise `none` when there are no check runs and `total_count` is 0. Otherwise `passing`. (GitHub reports `state: 'pending'` with `total_count: 0` for a commit with no statuses; that must not count as pending.) `linesChanged` = additions + deletions. `filesChanged` = `pull.changed_files`. `docsOnly`: at least one file, and every filename ends in `.md`, `.mdx` or `.txt` (case-insensitive) or has a path segment equal to `docs`. `testsTouched`: any filename contains `test` or `spec`, case-insensitive. `approvals` and `changesRequested`: walk `reviews` in order, keep each reviewer's latest state among `APPROVED`, `CHANGES_REQUESTED` and `DISMISSED` (ignore `COMMENTED` and `PENDING`, ignore a null user), then count. `authorIsBot`: `pull.user.type === 'Bot'`.
  Tests: docs-only PR; docs-only false when one `.ts` file is present; zero files is not docs-only; failing beats pending; `pending` with `total_count: 0` and no check runs is `none`; a skipped or neutral conclusion is passing; a reviewer who approved then requested changes counts once, as changes requested; a dismissed approval counts as nothing; a COMMENTED review after an approval leaves the approval standing; bot author.
- [ ] **criteria.** `expectedVerdict` implements the spec's rule in this precedence: `no`, then `unclear`, then `yes`, then `lean_yes`. `PR_CRITERIA` states each verdict's condition in words, naming the signal fields and the numbers exactly as the spec does, so that the four are mutually exclusive as written. `PR_INSTRUCTIONS` explains in three or four sentences what the state is (a pull request described by these fields, each named with its meaning), that the question is whether it can be approved on a light read, and to answer with one verdict only.
  Tests: `expectedVerdict` at 50, 51, 300, 301, 800, 801 lines with CI passing; docs-only at 5000 lines is `yes`; failing CI, draft, and changes requested are each `no` regardless of size; pending and none are `unclear`; a draft with pending CI is `no`; every verdict in `VERDICTS` has a non-empty criterion; each criterion mentions the numbers it depends on.
- [ ] **phrases.** Tests: five phrases per verdict, 20 distinct in total, wording equal to the spec's list; `pickPhrase` with `rng` returning 0 and 0.999 gives the first and last phrase of the group; `HAZY` is one of the `unclear` phrases.
- [ ] **reason.** At most three parts joined by ` · `, most decisive first: for `no` lead with whichever of `CI failing`, `draft`, `changes requested`, `N lines` caused it; for `unclear` lead with `CI pending`, `no CI` or `N lines`; for `yes` and `lean_yes` use `docs only` or `N lines`, then `CI passing`, then `N approvals` when above 0 (`1 approval` singular). Tests: one per branch, asserting the full string.
- [ ] `corepack pnpm test` and `corepack pnpm typecheck` pass. Commit.

### Task 2: server

**Files:** create `packages/server/src/handler.ts`, `packages/server/src/handler.test.ts`, `api/ask.ts`, `scripts/verify-criteria.ts`. Imports core as `../../core/src/index.js`.

```ts
// handler.ts
export interface AskDeps {
  /** Test seam. Defaults to the real Jev call. */
  decide?: (signals: PrSignals, signal: AbortSignal) => Promise<Verdict>;
  /** Defaults to process.env.ASK_PASSPHRASE. */
  passphrase?: string | undefined;
  timeoutMs?: number; // default 5000
}
export async function handleAsk(request: Request, deps?: AskDeps): Promise<Response>;
// api/ask.ts
export const POST = (request: Request) => handleAsk(request);
```

- [ ] Read `node_modules/ai/docs` for `experimental_evaluate` before writing the call. The known-good shape, from a project that used it in production:

```ts
import { experimental_evaluate as evaluate } from 'ai';
const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: { ...signals },           // a plain JSON object
  questions: PR_QUESTIONS,
  maxRetries: 0,
  abortSignal,
});
const choice = result.answers.verdict.choice; // validate it is one of VERDICTS, else throw
```

- [ ] `handleAsk`: refuse with 401 `unauthorized` when the configured passphrase is missing or empty, or the `x-magic-jev-key` header (use `PASSPHRASE_HEADER`) does not match it under a constant-time comparison. Check this before reading the body. Parse the body with a strict zod schema for `AskRequest` (`z.strictObject`, finite non-negative integers for the counts, the `ci` enum); failure is 400 `bad_request` with a short message naming the first bad path. Call `decide` under an `AbortController` that fires at `timeoutMs`; time only that call with `performance.now()`. Success is 200 `{ ok: true, verdict, latencyMs }` with `latencyMs` rounded. Error mapping: `APICallError` with status 402, or text containing `quota_for_entity_exceeded` or `insufficient` credit wording, is 402 `out_of_credits`; status 429 is 429 `rate_limited`; a timeout is 502 `model_error` with message `Jev did not answer in time.`; anything else is 502 `model_error` with the fixed message `The model call failed.` Never return provider text. Every response is JSON with `cache-control: no-store`. Only POST reaches this function through `api/ask.ts`, so no method check is needed.
  Tests (all with `decide` injected, no network): right passphrase passes; wrong, missing header, and unset configured passphrase are each 401 and `decide` is not called; bad JSON, unknown key, negative count, bad `ci` are 400; success shape and that `decide` received exactly the signals; 402, 429, timeout (a `decide` that waits on the abort signal, `timeoutMs: 20`) and generic error mappings; no response body contains the thrown error's message; `cache-control` header present. One more test imports `PR_QUESTIONS` and asserts the default decider would send it, by exporting a small pure `jevRequest(signals)` that returns the `evaluate` arguments minus the abort signal.
- [ ] `scripts/verify-criteria.ts`: reads `MAGIC_JEV_URL` and `MAGIC_JEV_KEY` from the environment (exit 1 with a clear message if unset). Builds about 40 `PrSignals`: for each of the thresholds 50, 300, 800 the values 10 percent below, just below, at, just above, and 10 percent above, with CI passing; docs-only at three sizes; failing, pending and no CI at two sizes each; draft; changes requested; a bot author; approvals 0 and 3. Posts each to `${MAGIC_JEV_URL}/api/ask` one at a time, prints a row per case (`expected`, `got`, `ms`, and `MISS` with the distance to the nearest threshold), then the score, the average latency, and whether the bar is met: at least 90 percent, and no miss further than 10 percent from a threshold. Exit code 0 when met, 2 when not.
- [ ] `corepack pnpm test` and `corepack pnpm typecheck` pass. Commit.

### Task 3: extension worker and options

**Files:** create `packages/extension/src/{github,settings,background,options}.ts`, `packages/extension/src/github.test.ts`, `packages/extension/static/options.html`. Imports core as `../../core/src/index.js`.

```ts
// github.ts   (every function takes the token and an injectable fetch for tests)
export async function fetchRawPr(ref: PrRef, token: string, fetchFn?: typeof fetch): Promise<RawPr>;
export async function fetchLogin(token: string, fetchFn?: typeof fetch): Promise<string>;
export async function searchReviewRequests(token: string, fetchFn?: typeof fetch): Promise<Array<{ id: number; title: string; htmlUrl: string }>>;
export class GitHubError extends Error { status: number }
// settings.ts
export async function loadSettings(): Promise<Settings>;
export async function saveSettings(settings: Settings): Promise<void>;
export function isConfigured(settings: Settings): boolean;
```

- [ ] **github.ts.** Base `https://api.github.com`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. `fetchRawPr` gets the pull first, then in parallel: files and reviews (follow pagination with `per_page=100` and `page=N` until a short page, capped at 10 pages), the combined status (`per_page=100`) and the check runs for `pull.head.sha` (paged the same way as files, reading `check_runs` from each page). A non-2xx response throws `GitHubError` with the status. `searchReviewRequests` calls `/search/issues?q=` with `is:open is:pr user-review-requested:@me archived:false` (direct requests only, matching the `requested_reviewers` rule the ball uses), URL-encoded, `per_page=50`.
  Tests with a fake fetch: the URLs and headers requested; pagination stops on a short page; a 401 throws `GitHubError` with status 401; the search query is encoded and mapped to `{ id, title, htmlUrl }`.
- [ ] **background.ts.** On `chrome.runtime.onInstalled` and `onStartup`, create the alarm `poll` with `periodInMinutes: 2` and poll once. On the alarm: if not configured, return; search; if `STORAGE_KEYS.seeded` is not set, store every id as seen and set it, raising nothing; otherwise for each unseen id raise `chrome.notifications.create` with id `pr:<htmlUrl>`, `type: 'basic'`, `iconUrl: 'icon-128.png'`, title `Review requested`, the PR title as message, and one button `Ask Magic Jev`, then store the id. Keep at most the newest 500 ids. A `GitHubError` with status 403 or 429 skips the tick silently; others are logged with `console.warn`. Clicking the notification or its button opens the URL in a new tab and clears the notification.
  `chrome.runtime.onMessage` handles `WorkerRequest` and must `return true` to answer asynchronously. `pr-status`: not configured gives `{ configured: false, show: true }`; configured and `showOnEveryPr` gives `show: true`; otherwise fetch the pull and the login (cache the login in memory per token) and `show` is whether the login is in `requested_reviewers`; on any error `show: false`. `ask`: fetch the raw PR, `buildPrSignals`, POST `{ kind: 'pr', signals }` to `${serverUrl}/api/ask` with the passphrase header, and reply with `AskReply`. Failure reasons, in plain words: GitHub 401 `GitHub token rejected`; GitHub 403 or 429 `GitHub rate limit reached`; GitHub 404 `GitHub cannot see this pull request`; server `unauthorized` `server passphrase rejected`; `out_of_credits` `out of Gateway credits`; `rate_limited` `Jev is rate limited`; `model_error` uses the server's message without its full stop; a thrown fetch `could not reach the server`; not configured `open the options page first`, with `openOptions: true` on the reply so the ball draws that line as a link. A third message, `{ type: 'open-options' }`, makes the worker call `chrome.runtime.openOptionsPage()`, because a content script cannot.
- [ ] **options.** A plain, tidy form: GitHub token (password input), server URL, passphrase (password input), the `showOnEveryPr` checkbox labelled `Show the ball on every pull request (demo)`, a Save button and a status line. Trim values and strip a trailing slash from the URL. A `Test` button runs `fetchLogin` and one POST to the server with a fixed small `PrSignals`, and reports `GitHub: signed in as <login>` and `Server: <verdict> in <ms> ms`, or the failure in the same plain words as above. One short line under the token field says it needs read access to pull requests, commit statuses and checks. Inline CSS, system font, works in light and dark.
- [ ] `corepack pnpm test`, `corepack pnpm typecheck` pass. `corepack pnpm build:extension` will fail until Task 4's `content.ts` exists; if it does not exist yet when you finish, verify your entry points alone with `node -e` and esbuild's `build` on `background.ts` and `options.ts`. Commit.

### Task 4: the ball

**Files:** create `packages/extension/src/{pr-url,ball,content}.ts`, `packages/extension/src/pr-url.test.ts`, `packages/extension/static/icon-128.png`, and `scripts/make-icon.mjs` that generates the icon.

```ts
// pr-url.ts
export function parsePrUrl(pathname: string): PrRef | null; // '/o/r/pull/12' and '/o/r/pull/12/files' -> ref; anything else -> null
// ball.ts
export interface Ball { destroy(): void }
export function mountBall(onAsk: () => Promise<{ phrase: string; reason: string }>): Ball;
```

- [ ] **pr-url.** Tests: the PR page, its `/files`, `/commits` and `/checks` tabs, a trailing slash, `/pull/new` and `/pulls` give null, a non-numeric number gives null.
- [ ] **ball.ts.** A host element fixed to the bottom-right (24 px in, `z-index` 2147483000) with an open shadow root holding all markup and CSS, so GitHub's styles cannot reach it. The ball is a 96 px black sphere drawn in CSS (radial gradient highlight, soft shadow) with a white circle and an `8`. It is a `<button>` with `aria-label="Ask Magic Jev: should I approve this?"`, focusable, Enter and Space work. On click: if already asking, ignore; start a shake animation (CSS keyframes, translate and rotate, 120 ms per cycle); call `onAsk()`; when it resolves and at least 900 ms have passed since the click, stop shaking, flip to the answer face: the dark blue triangle window with the phrase in white uppercase, text sized to fit (three lines at most), and the reason line under the ball in a small pill. `aria-live="polite"` on the answer. Clicking again asks again. A small `x` on hover removes the ball for this page. Respect `prefers-reduced-motion`: no shake, a 900 ms fade instead.
- [ ] **content.ts.** On load and on every navigation (`turbo:load`, `popstate`, and a `MutationObserver`-free fallback: compare `location.pathname` on a 1 s interval), run `parsePrUrl(location.pathname)`. No ref, or the same ref as already mounted: do nothing, except destroy the ball when leaving a PR. New ref: send `{ type: 'pr-status', ...ref }`; if `show`, mount the ball. `onAsk` sends `{ type: 'ask', ...ref }`; on `ok`, returns `pickPhrase(verdict)` and `reasonFor(signals, verdict)` followed by ` · <latencyMs> ms`; on failure returns `HAZY` and the reason. If `chrome.runtime.sendMessage` throws (the extension was reloaded), return `HAZY` and `reload this page`. Guard against a stale reply: if the ref changed while waiting for `pr-status`, do not mount.
- [ ] **icon.** `scripts/make-icon.mjs` writes a 128 by 128 PNG of the 8 ball using only `node:zlib` and `node:fs` (no dependencies): black disc with a soft highlight, white inner circle, a blocky black 8, transparent corners. Run it and commit the PNG.
- [ ] `corepack pnpm test`, `corepack pnpm typecheck` pass. If `background.ts` and `options.ts` exist, `corepack pnpm build:extension` succeeds and `packages/extension/dist` holds `manifest.json`, `background.js`, `content.js`, `options.js`, `options.html`, `icon-128.png`. Commit.

### Task 5: review, fix, verify

- [ ] Three independent reviews of the whole diff against the spec and this plan: correctness and bugs; MV3 and browser behaviour (service worker lifetime, async `onMessage`, content script on a Turbo-navigated site, shadow root, permissions in the manifest against what the code calls); security and privacy (the token and passphrase never reach a content script, a page, a log or the server; the server returns no provider text; the passphrase comparison).
- [ ] Each finding is checked by a second agent that tries to refute it. Confirmed findings are fixed by one agent, with a test where a test is possible.
- [ ] Final gate: `corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm build:extension` all succeed from a clean `dist`.

### After the workflow (done by hand, touches accounts)

- [ ] Deploy to Vercel, set `ASK_PASSPHRASE`, run `verify:criteria` against the deployment. This is the spec's checkpoint: below the bar, reword the criteria before demoing.
- [ ] Load `packages/extension/dist` unpacked, fill in the options page, run the manual checklist from the spec.
