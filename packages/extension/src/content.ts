/**
 * The content script. It runs on every github.com page, because GitHub moves
 * between pages without loading them, and draws the ball when the page is a
 * pull request the worker says to show it on. It makes no network calls and
 * never sees the token or the passphrase: it only messages the worker.
 */
import { HAZY, pickPhrase, reasonFor } from '../../core/src/index.js';
import { mountBall, type Ball, type BallAnswer } from './ball.js';
import type { AskReply, PrRef, PrStatusReply, WorkerRequest } from './messages.js';
import { parsePrUrl } from './pr-url.js';

/** The pull request this page was last checked for, as `owner/repo#number`. Null off a pull request. */
let currentKey: string | null = null;
let ball: Ball | null = null;
/** Goes up each time a new pull request is checked, so a slow reply can tell it has been overtaken. */
let generation = 0;

const keyOf = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

/** A content script cannot open the options page, so the worker is asked to. */
function openOptions(): void {
  const request: WorkerRequest = { type: 'open-options' };
  // Rejects when the extension was reloaded under this page. There is nothing to do about that here.
  chrome.runtime.sendMessage(request).catch(() => undefined);
}

async function ask(ref: PrRef): Promise<BallAnswer> {
  let reply: AskReply | undefined;
  try {
    const request: WorkerRequest = { type: 'ask', ...ref };
    reply = await chrome.runtime.sendMessage<WorkerRequest, AskReply | undefined>(request);
  } catch {
    // The extension was reloaded or updated under this page, so this script has lost its worker.
    return { phrase: HAZY, reason: 'reload this page' };
  }
  if (!reply) return { phrase: HAZY, reason: 'the extension did not answer' };
  if (!reply.ok) {
    return reply.openOptions
      ? { phrase: HAZY, reason: reply.reason, onReasonClick: openOptions }
      : { phrase: HAZY, reason: reply.reason };
  }
  return {
    phrase: pickPhrase(reply.verdict),
    reason: `${reasonFor(reply.signals, reply.verdict)} · ${Math.round(reply.latencyMs)} ms`,
    // Only the confident yes. A leaning yes is not a party.
    celebrate: reply.verdict === 'yes',
  };
}

function removeBall(): void {
  ball?.destroy();
  ball = null;
}

async function check(): Promise<void> {
  const ref = parsePrUrl(location.pathname);
  if (!ref) {
    currentKey = null;
    removeBall();
    return;
  }
  const key = keyOf(ref);
  // The tabs of one pull request share a ref. This also keeps a ball the user closed from coming back.
  if (key === currentKey) return;
  currentKey = key;
  removeBall();
  const mine = ++generation;

  let status: PrStatusReply | undefined;
  try {
    const request: WorkerRequest = { type: 'pr-status', ...ref };
    status = await chrome.runtime.sendMessage<WorkerRequest, PrStatusReply | undefined>(request);
  } catch {
    // No worker to ask (the extension was reloaded). A fresh page load brings a fresh script.
    return;
  }
  // The page may have moved on while the worker was asking GitHub, even away and back again.
  if (mine !== generation || currentKey !== key) return;
  if (status?.show) ball = mountBall(() => ask(ref));
}

const run = () => void check();

document.addEventListener('turbo:load', run);
window.addEventListener('popstate', run);
// Neither event covers every way GitHub changes the URL, so the path is also compared once a second.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  run();
}, 1000);
run();
