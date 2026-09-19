/**
 * Everything that crosses between the content script, the options page and
 * the background worker. The worker owns every network call; the others only
 * send these messages with chrome.runtime.sendMessage.
 */
import type { PrSignals, Verdict } from '../../core/src/index.js';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface Settings {
  githubToken: string;
  /** Origin of the deployed server, e.g. https://magic-jev.vercel.app (no trailing slash). */
  serverUrl: string;
  passphrase: string;
  /** Demo switch: draw the ball on every pull request, not only ones awaiting my review. */
  showOnEveryPr: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  githubToken: '',
  serverUrl: '',
  passphrase: '',
  showOnEveryPr: false,
};

/** chrome.storage.local keys. */
export const STORAGE_KEYS = { settings: 'settings', seenPrIds: 'seenPrIds', seeded: 'seeded' } as const;

export type WorkerRequest =
  | ({ type: 'pr-status' } & PrRef)
  | ({ type: 'ask' } & PrRef)
  /** Opens the options page. A content script cannot do that itself. No reply. */
  | { type: 'open-options' };

/** Messages arrive as plain JSON. The worker checks the shape before acting on one. */
export function isWorkerRequest(message: unknown): message is WorkerRequest {
  if (typeof message !== 'object' || message === null) return false;
  const { type, owner, repo, number } = message as Record<string, unknown>;
  if (type === 'open-options') return true;
  return (
    (type === 'pr-status' || type === 'ask') &&
    typeof owner === 'string' &&
    owner !== '' &&
    typeof repo === 'string' &&
    repo !== '' &&
    typeof number === 'number' &&
    Number.isInteger(number) &&
    number > 0
  );
}

/** Reply to 'pr-status': should the ball be drawn on this page? */
export interface PrStatusReply {
  /** Token, server URL and passphrase are all set. */
  configured: boolean;
  /** configured, and (showOnEveryPr or the token's login is a requested reviewer). Also true when not configured, so the ball can say so. */
  show: boolean;
}

/**
 * Reply to 'ask'. A failure still ends the shake: `reason` is the plain-words line under "Reply hazy, try again".
 * `openOptions` is set when the fix is on the options page, so the ball can make the reason line a link to it.
 */
export type AskReply =
  | { ok: true; verdict: Verdict; signals: PrSignals; latencyMs: number }
  | { ok: false; reason: string; openOptions?: true };
