/**
 * The options page: the GitHub token, the server URL, the passphrase and the
 * demo switch. This is an extension page, not a content script, so it may hold
 * the secrets and make the two test calls itself.
 */
import type { PrSignals } from '../../core/src/index.js';
import { askServer, fetchLogin, githubFailureReason } from './github.js';
import { HOSTED_SERVER_URL, type Settings } from './messages.js';
import { loadSettings, saveSettings } from './settings.js';
import { serverUrlSuggestion, tokenNote } from './setup-hints.js';

/** A small, green pull request for the Test button. The rule says `yes`, so Jev should too. */
const TEST_SIGNALS: PrSignals = {
  ci: 'passing',
  linesChanged: 12,
  filesChanged: 1,
  docsOnly: false,
  testsTouched: true,
  approvals: 1,
  changesRequested: 0,
  isDraft: false,
  authorIsBot: false,
};

/** Header values must be printable ASCII, or fetch refuses to send them. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`options.html has no #${id}`);
  return found as T;
}

const form = element<HTMLFormElement>('form');
const tokenInput = element<HTMLInputElement>('githubToken');
const urlInput = element<HTMLInputElement>('serverUrl');
const passphraseInput = element<HTMLInputElement>('passphrase');
const everyPrInput = element<HTMLInputElement>('showOnEveryPr');
const saveButton = element<HTMLButtonElement>('save');
const testButton = element<HTMLButtonElement>('test');
const statusLine = element<HTMLParagraphElement>('status');

function setStatus(message: string, tone: 'plain' | 'good' | 'bad' = 'plain'): void {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

/**
 * The server's origin, or a plain-words complaint. Anything after the origin
 * is dropped, so a pasted `https://host/api/ask/` still works. The passphrase
 * travels in a header, so only https is accepted, or http on this machine.
 */
function normaliseServerUrl(value: string): { origin: string } | { problem: string } {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return { origin: '' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { problem: 'Server URL is not a URL. It should look like https://magic-jev.vercel.app' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { problem: 'Server URL must start with https://' };
  }
  return { origin: url.origin };
}

/** The form as Settings, trimmed, or a complaint to show instead. */
function readForm(): { settings: Settings } | { problem: string } {
  const server = normaliseServerUrl(urlInput.value);
  if ('problem' in server) return server;
  const githubToken = tokenInput.value.trim();
  const passphrase = passphraseInput.value.trim();
  if (!PRINTABLE_ASCII.test(githubToken)) return { problem: 'GitHub token has characters a token cannot contain.' };
  if (!PRINTABLE_ASCII.test(passphrase)) return { problem: 'Passphrase must be plain ASCII letters, digits and symbols.' };
  // An emptied server field goes back to the shared server.
  const serverUrl = server.origin === '' ? HOSTED_SERVER_URL : server.origin;
  return { settings: { githubToken, serverUrl, passphrase, showOnEveryPr: everyPrInput.checked } };
}

function fillForm(settings: Settings): void {
  tokenInput.value = settings.githubToken;
  urlInput.value = settings.serverUrl;
  passphraseInput.value = settings.passphrase;
  everyPrInput.checked = settings.showOnEveryPr;
}

/** The worker can only reach hosts the manifest allows. Better to say so here than to fail on the ball. */
async function canReach(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return true;
  }
}

function notAllowed(origin: string): string {
  const suggestion = serverUrlSuggestion(origin);
  if (suggestion) return `${origin} looks mistyped. Did you mean ${suggestion}?`;
  return `this extension is not allowed to reach ${origin}. Its manifest lists the hosts it may call.`;
}

async function save(): Promise<void> {
  const result = readForm();
  if ('problem' in result) {
    setStatus(result.problem, 'bad');
    return;
  }
  const { settings } = result;
  await saveSettings(settings);
  // Show what was stored: trimmed, and the URL cut down to its origin.
  fillForm(settings);

  if (settings.serverUrl !== '' && !(await canReach(settings.serverUrl))) {
    setStatus(`Saved, but ${notAllowed(settings.serverUrl)}`, 'bad');
    return;
  }
  setStatus(settings.githubToken === '' ? 'Saved. No token: public pull requests only.' : 'Saved.', 'good');
}

async function testGitHub(settings: Settings): Promise<{ ok: boolean; line: string }> {
  if (settings.githubToken === '') return { ok: true, line: 'GitHub: no token, so public pull requests only' };
  try {
    const login = await fetchLogin(settings.githubToken);
    const note = tokenNote(settings.githubToken);
    return { ok: true, line: `GitHub: signed in as ${login}${note ? `. ${note}` : ''}` };
  } catch (error) {
    return { ok: false, line: `GitHub: ${githubFailureReason(error)}` };
  }
}

async function testServer(settings: Settings): Promise<{ ok: boolean; line: string }> {
  if (settings.serverUrl === '') return { ok: false, line: 'Server: no URL yet' };
  // Without this the fetch below is blocked and all the user sees is "could not reach the server".
  if (!(await canReach(settings.serverUrl))) return { ok: false, line: `Server: ${notAllowed(settings.serverUrl)}` };
  const reply = await askServer(settings, TEST_SIGNALS);
  return reply.ok
    ? { ok: true, line: `Server: ${reply.verdict} in ${reply.latencyMs} ms` }
    : { ok: false, line: `Server: ${reply.reason}` };
}

/** Tests what is in the form right now, saved or not. */
async function test(): Promise<void> {
  const result = readForm();
  if ('problem' in result) {
    setStatus(result.problem, 'bad');
    return;
  }
  setStatus('Testing...');
  const [github, server] = await Promise.all([testGitHub(result.settings), testServer(result.settings)]);
  setStatus(`${github.line}\n${server.line}`, github.ok && server.ok ? 'good' : 'bad');
}

/** Runs one action with both buttons disabled, so a double click cannot start two. */
async function busy(action: () => Promise<void>): Promise<void> {
  saveButton.disabled = true;
  testButton.disabled = true;
  try {
    await action();
  } catch {
    setStatus('Something went wrong. Try again.', 'bad');
  } finally {
    saveButton.disabled = false;
    testButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void busy(save);
});
testButton.addEventListener('click', () => void busy(test));

void loadSettings().then(fillForm, () => setStatus('Could not read the saved settings.', 'bad'));
