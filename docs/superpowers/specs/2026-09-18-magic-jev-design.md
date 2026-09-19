# Magic Jev: design

Date: 2026-09-18. Status: approved in conversation, awaiting written review.

## What it is

A Chrome extension that puts a Magic 8 Ball on the decisions that land in your
inbox. When a pull request asks for your review, the ball appears; you click it,
it shakes, and it answers "should I approve this?" with one of the 20 classic
phrases. The answer is not random: real signals about the PR go to Jev
(TypeSafe's typed-decision model), which picks a verdict in a few hundred
milliseconds, fast enough to land inside the shake animation.

The ball never acts. It does not approve, comment or decline anything. It
answers, and shows one line saying why.

## Scope

**Phase 1 (this spec): GitHub pull requests.** Needs only a GitHub token.

**Phase 2 (outline only, own plan later): calendar invites.** Same shape, plus
a Google OAuth client. See "Phase 2" at the end.

**Out of scope:** free-form questions, a chat model writing criteria, mobile,
Gmail, push on arrival from a server, any action taken on the user's behalf,
multiple users or accounts.

## What Jev is asked

Jev compares signals against criteria; it does not read code. So the question
the ball really answers is "can this be approved on a light read?", and the
signal builder does all arithmetic before Jev sees anything (in jev-pong the
engine computed `interceptY`; Jev only compared it).

One call per ask, `experimental_evaluate` from the `ai` package, model
`typesafe-ai/jev` through Vercel AI Gateway, `maxRetries: 0`, one question of
`type: 'choice'` with four criteria. This is the call shape jev-pong used and we
measured at roughly 230 to 350 ms.

### PR signals

Built from the GitHub REST API. Numbers, booleans and one short enum, nothing
else.

| Signal | Meaning |
|---|---|
| `ci` | `'passing'`, `'failing'`, `'pending'` or `'none'`, from the head commit's combined status and check runs. Any failure is `failing`; otherwise any pending is `pending`. |
| `linesChanged` | additions + deletions |
| `filesChanged` | count |
| `docsOnly` | every changed file is `.md`, `.mdx`, `.txt`, or under `docs/` |
| `testsTouched` | any changed path contains `test` or `spec` |
| `approvals` | reviews in state APPROVED, latest per reviewer |
| `changesRequested` | reviews in state CHANGES_REQUESTED, latest per reviewer |
| `isDraft` | the PR is a draft |
| `authorIsBot` | the author's type is `Bot` |

### PR criteria

Written once, in `core`, and used only by the server, so a client cannot inject
its own.

The four are mutually exclusive, and every signal set matches exactly one.

- **no**: `ci` is failing, or it is a draft, or `changesRequested` is above 0,
  or `docsOnly` is false and `linesChanged` is above 800.
- **unclear**: none of the `no` conditions hold, and either `ci` is pending or
  none, or `ci` is passing with `docsOnly` false and `linesChanged` between 301
  and 800. This one needs a real read.
- **yes**: `ci` is passing, not a draft, `changesRequested` is 0, and either
  `docsOnly` is true (any size) or `linesChanged` is at most 50.
- **lean_yes**: `ci` is passing, not a draft, `changesRequested` is 0,
  `docsOnly` is false, and `linesChanged` is between 51 and 300.

`expectedVerdict(signals)` in `core` computes the same rule locally. Tests and
the live check use it; the ball never does.

### Verdict to phrase

Jev picks the verdict; the extension picks a random phrase from that group, which
restores the randomness an 8 Ball should have.

- **yes**: It is certain. It is decidedly so. Without a doubt. Yes definitely.
  You may rely on it.
- **lean_yes**: As I see it, yes. Most likely. Outlook good. Yes. Signs point
  to yes.
- **unclear**: Reply hazy, try again. Ask again later. Better not tell you now.
  Cannot predict now. Concentrate and ask again.
- **no**: Don't count on it. My reply is no. My sources say no. Outlook not so
  good. Very doubtful.

Under the phrase, one reason line built by `reasonFor(signals, verdict)` in
`core`, deterministic and not from Jev: for example "CI failing · 912 lines" or
"docs only · CI passing".

## Architecture

A pnpm workspace with three packages.

### `packages/core`

Pure TypeScript, no browser or server APIs. Holds the types (`PrSignals`,
`Verdict`, `AskRequest`, `AskResponse`), `buildPrSignals(raw)` which turns raw
GitHub API payloads into `PrSignals`, the PR criteria and instructions,
`expectedVerdict`, `reasonFor`, and the phrase table with `pickPhrase(verdict,
rng)`.

### `packages/server`

One Vercel function, `POST /api/ask`.

- Body: `{ kind: 'pr', signals: PrSignals }`, validated with zod. Unknown keys
  are rejected.
- Auth: header `x-magic-jev-key` compared in constant time with the
  `ASK_PASSPHRASE` environment variable. Missing variable means every request is
  refused. This exists because a public route spends Gateway credits.
- Calls Jev with a 5 second timeout and returns `{ verdict, latencyMs }`, where
  `latencyMs` is timed around the model call alone.
- Errors are typed and carry no provider text: 400 `bad_request`, 401
  `unauthorized`, 402 `out_of_credits`, 429 `rate_limited`, 502 `model_error`.
- Gateway auth is Vercel OIDC on the deployment; `AI_GATEWAY_API_KEY` locally.

### `packages/extension`

Manifest V3, TypeScript, bundled with esbuild.

- **Background service worker.** On a `chrome.alarms` tick every 2 minutes it
  calls GitHub search, `is:open is:pr user-review-requested:@me archived:false`
  (requests made to the user directly, not to a team, so that every
  notification opens a PR the ball is drawn on), and
  compares the result with the PR ids in `chrome.storage.local`. The first
  poll after install only records what it finds. After that, each new one
  raises a `chrome.notifications` notification with an "Ask Magic Jev" button,
  which opens the PR. It also owns every network call: it fetches the PR, its
  files, reviews and checks, builds the signals with `core`, and calls
  `/api/ask`. Content scripts only message it.
- **Content script** on `https://github.com/*/*/pull/*`. It asks the worker
  whether this PR is awaiting the user's review (the token's login is in the
  PR's `requested_reviewers`), and only then draws the ball in the
  bottom-right corner, in a shadow root so GitHub's CSS cannot touch it. Click:
  shake animation (900 ms minimum, so the answer always lands inside it), then
  the phrase in the triangle and the reason line. GitHub navigates without page
  loads, so the script re-checks the URL on `turbo:load` and `popstate`.
- **Options page.** GitHub token, server URL, passphrase. Stored in
  `chrome.storage.local`. The token needs read access to pull requests, commit
  statuses and checks.

### Data flow for one ask

1. Click the ball. The content script sends `{ owner, repo, number }` to the
   worker and starts the shake.
2. The worker fetches the PR, files, reviews, combined status and check runs in
   parallel, and builds `PrSignals`.
3. The worker posts to `/api/ask`. The server asks Jev and returns the verdict.
4. The worker returns `{ verdict, signals }`. The content script picks the
   phrase, builds the reason line and ends the shake on the answer.

## Errors

Every failure still ends the shake on an answer, because a ball that hangs is
worse than a ball that shrugs: the phrase is "Reply hazy, try again" and the
reason line names the failure in plain words ("GitHub token rejected", "server
passphrase rejected", "out of Gateway credits", "Jev did not answer in time").
No token or passphrase configured: the ball shows "Open the options page first"
and links to it. GitHub rate limit: the poll skips that tick and tries the next.

## Testing

- **`core`, unit tests (vitest).** `buildPrSignals` against recorded GitHub
  payloads for: a docs-only PR, a large PR, failing CI, pending CI, no CI, a
  draft, a bot author, and reviews where one reviewer approved then requested
  changes. `expectedVerdict` on each side of every threshold (50, 51, 300, 301,
  800, 801). `reasonFor` and `pickPhrase` with a seeded rng.
- **`server`, unit tests.** The route with `evaluate` mocked: passphrase
  accepted and refused, missing `ASK_PASSPHRASE`, bad bodies, each error
  mapping, and that the criteria sent are the ones in `core`.
- **Live check, `pnpm verify:criteria`.** Runs a table of about 40 signal sets
  through the real route and reports how often Jev matches `expectedVerdict`,
  and where the misses are. In jev-pong Jev scored about 93 percent with every
  miss within a unit or two of a threshold, so the bar here is: at least 90
  percent, and no miss further than 10 percent from a threshold. If it fails
  that bar the criteria get reworded before anything else is built on them.
  This runs first, before the extension exists.
- **Extension, manual checklist.** Load unpacked; a PR awaiting my review shows
  the ball; a PR that is not mine to review does not; click gives an answer
  inside the shake; bad token, bad passphrase and server down each end on the
  hazy answer with the right reason; a new review request raises one
  notification, once.

## Build order

1. `core` with tests.
2. `server` with tests, deployed, then `verify:criteria` live. This is the
   checkpoint: if Jev cannot hold these criteria, stop and reword.
3. `extension`: worker and options page first, then the ball.

## Phase 2: calendar invites (outline)

Same three packages, one more `kind`. Signals from the Google Calendar API
through `chrome.identity` with a read-only calendar scope: duration, attendee
count, required or optional, has a description, conflicts with an accepted
event, meetings already that day, outside working hours (hours set on the
options page). The worker polls for events where the user's response is
`needsAction`. A content script on `calendar.google.com` draws the same ball.
Needs a Google Cloud OAuth client, which is why it comes second. It gets its own
spec section and plan when phase 1 is in use.
