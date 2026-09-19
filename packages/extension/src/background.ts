/**
 * The background service worker. It owns every network call: it polls GitHub
 * for new review requests and raises notifications, and it answers the
 * messages a content script can send ('pr-status', 'ask' and 'open-options').
 *
 * Chrome stops this worker when it is idle and starts it again for an event,
 * so every listener is registered at the top level, and anything that must
 * survive lives in chrome.storage.local. The only in-memory state is a cache
 * that is cheap to rebuild.
 */
import { buildPrSignals } from '../../core/src/index.js';
import {
  GitHubError,
  askServer,
  fetchLogin,
  fetchPull,
  fetchRawPr,
  githubFailureReason,
  searchReviewRequests,
} from './github.js';
import { STORAGE_KEYS, isWorkerRequest, type AskReply, type PrRef, type PrStatusReply } from './messages.js';
import { isConfigured, loadSettings } from './settings.js';

const POLL_ALARM = 'poll';
const POLL_MINUTES = 2;
const MAX_SEEN_IDS = 500;
const NOTIFICATION_PREFIX = 'pr:';
const PULL_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

// Keep the token and the passphrase out of reach of content scripts. By
// default chrome.storage.local can be read from a content script; this limits
// it to the worker and the extension's own pages.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

// ---------------------------------------------------------------- polling

function startPolling(): void {
  // Creating an alarm with the same name replaces it, so this is safe to repeat.
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  void poll();
}

chrome.runtime.onInstalled.addListener(startPolling);
chrome.runtime.onStartup.addListener(startPolling);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void poll();
});

// Saving the options page should not mean waiting two minutes for the first
// poll, and a new token means the cached login may be someone else's.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEYS.settings in changes)) return;
  cachedLogin = null;
  void poll();
});

/** One poll at a time. Two overlapping polls could both decide the same request is new. */
let pollInFlight: Promise<void> | null = null;

function poll(): Promise<void> {
  pollInFlight ??= pollOnce()
    .catch((error: unknown) => {
      // A rate limit skips this tick silently; the next one tries again.
      if (error instanceof GitHubError && (error.status === 403 || error.status === 429)) return;
      // GitHubError messages hold a status only. Anything else is reduced to plain words first.
      console.warn('Magic Jev: poll failed:', error instanceof GitHubError ? error.message : githubFailureReason(error));
    })
    .finally(() => {
      pollInFlight = null;
    });
  return pollInFlight;
}

async function pollOnce(): Promise<void> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) return;

  const requests = (await searchReviewRequests(settings.githubToken)).filter(
    (request) => request.id > 0 && PULL_URL.test(request.htmlUrl),
  );

  const stored = await chrome.storage.local.get([STORAGE_KEYS.seenPrIds, STORAGE_KEYS.seeded]);
  const storedIds: unknown = stored[STORAGE_KEYS.seenPrIds];
  const seen: number[] = Array.isArray(storedIds) ? storedIds.filter((id): id is number => typeof id === 'number') : [];

  // The first poll only records what is already waiting, so installing the
  // extension does not raise a notification for every old request.
  if (stored[STORAGE_KEYS.seeded] !== true) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.seenPrIds]: requests.map((request) => request.id).slice(-MAX_SEEN_IDS),
      [STORAGE_KEYS.seeded]: true,
    });
    return;
  }

  const known = new Set(seen);
  const raised: number[] = [];
  for (const request of requests) {
    if (known.has(request.id)) continue;
    try {
      await chrome.notifications.create(`${NOTIFICATION_PREFIX}${request.htmlUrl}`, {
        type: 'basic',
        iconUrl: 'icon-128.png',
        title: 'Review requested',
        message: request.title,
        buttons: [{ title: 'Ask Magic Jev' }],
      });
      raised.push(request.id);
    } catch {
      // Not stored, so the next tick tries this one again.
      console.warn('Magic Jev: could not raise a notification');
    }
  }
  if (raised.length > 0) {
    // Newest last, so trimming from the front drops the oldest.
    await chrome.storage.local.set({ [STORAGE_KEYS.seenPrIds]: [...seen, ...raised].slice(-MAX_SEEN_IDS) });
  }
}

// ---------------------------------------------------------------- notifications

/** The notification id carries the pull request URL, so nothing has to be remembered between events. */
function openFromNotification(notificationId: string): void {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const url = notificationId.slice(NOTIFICATION_PREFIX.length);
  if (PULL_URL.test(url)) void chrome.tabs.create({ url });
  void chrome.notifications.clear(notificationId);
}

chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener((notificationId) => openFromNotification(notificationId));

// ---------------------------------------------------------------- messages

/** The login behind the token, kept in memory per token. Lost when the worker sleeps, which only costs one request. */
let cachedLogin: { token: string; login: string } | null = null;

async function loginFor(token: string): Promise<string> {
  if (cachedLogin?.token === token) return cachedLogin.login;
  const login = await fetchLogin(token);
  cachedLogin = { token, login };
  return login;
}

async function prStatus(ref: PrRef): Promise<PrStatusReply> {
  const settings = await loadSettings();
  // Not configured still shows the ball, so it can say "open the options page first".
  if (!isConfigured(settings)) return { configured: false, show: true };
  if (settings.showOnEveryPr) return { configured: true, show: true };
  try {
    const [pull, login] = await Promise.all([fetchPull(ref, settings.githubToken), loginFor(settings.githubToken)]);
    const me = login.toLowerCase();
    return { configured: true, show: pull.requested_reviewers.some((reviewer) => reviewer.login.toLowerCase() === me) };
  } catch {
    return { configured: true, show: false };
  }
}

async function ask(ref: PrRef): Promise<AskReply> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) return { ok: false, reason: 'open the options page first', openOptions: true };

  let signals;
  try {
    signals = buildPrSignals(await fetchRawPr(ref, settings.githubToken));
  } catch (error) {
    return { ok: false, reason: githubFailureReason(error) };
  }
  // Only the nine signals go to the server. The token stays here.
  return askServer(settings, signals);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only this extension's own scripts may ask.
  if (sender.id !== chrome.runtime.id || !isWorkerRequest(message)) return false;

  if (message.type === 'open-options') {
    // The ball's "open the options page first" line asks for this. Nothing to reply.
    void chrome.runtime.openOptionsPage();
    return false;
  }

  const ref: PrRef = { owner: message.owner, repo: message.repo, number: message.number };
  if (message.type === 'pr-status') {
    prStatus(ref).then(sendResponse, () => sendResponse({ configured: true, show: false } satisfies PrStatusReply));
  } else {
    ask(ref).then(sendResponse, () => sendResponse({ ok: false, reason: 'something went wrong in the extension' } satisfies AskReply));
  }
  // Keeps the message channel open until sendResponse is called.
  return true;
});
