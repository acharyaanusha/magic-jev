/**
 * Reads and writes the Settings in chrome.storage.local. Only the background
 * worker and the options page import this. Content scripts never see the
 * token or the passphrase; they only message the worker.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS, type Settings } from './messages.js';

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The stored settings, with a default for anything missing or of the wrong type. */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const value: unknown = stored[STORAGE_KEYS.settings];
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const saved = value as Record<string, unknown>;
  return {
    githubToken: asString(saved.githubToken),
    // An emptied field means "the hosted server", not "no server".
    serverUrl: asString(saved.serverUrl) || DEFAULT_SETTINGS.serverUrl,
    passphrase: asString(saved.passphrase),
    showOnEveryPr: saved.showOnEveryPr === true,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

/**
 * True when the ball can ask. Only the server is needed, and it has a default,
 * so this is true on a fresh install. The token and the passphrase are optional.
 */
export function isConfigured(settings: Settings): boolean {
  return settings.serverUrl !== '';
}

/** Review requests can only be looked up for someone, so polling and "is this mine?" need the token. */
export function hasToken(settings: Settings): boolean {
  return settings.githubToken !== '';
}
