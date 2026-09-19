/**
 * The options page: the GitHub token, the server URL, the passphrase and the
 * demo switch. This is an extension page, not a content script, so it may hold
 * the secrets and make the two test calls itself.
 */
import type { PrSignals } from '../../core/src/index.js';
import { askServer, fetchLogin, githubFailureReason } from './github.js';
import type { Settings } from './messages.js';
import { loadSettings, saveSettings } from './settings.js';

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
  return { settings: { githubToken, serverUrl: server.origin, passphrase, showOnEveryPr: everyPrInput.checked } };
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
    setStatus(`Saved, but this extension is not allowed to reach ${settings.serverUrl}. Its manifest lists the hosts it may call.`, 'bad');
    return;
  }
  const missing = [
    settings.githubToken === '' ? 'the GitHub token' : '',
    settings.serverUrl === '' ? 'the server URL' : '',
    settings.passphrase === '' ? 'the passphrase' : '',
  ].filter((name) => name !== '');
  if (missing.length > 0) {
    setStatus(`Saved. Still missing: ${missing.join(', ')}.`);
    return;
  }
  setStatus('Saved.', 'good');
}

async function testGitHub(settings: Settings): Promise<{ ok: boolean; line: string }> {
  if (settings.githubToken === '') return { ok: false, line: 'GitHub: no token yet' };
  try {
    return { ok: true, line: `GitHub: signed in as ${await fetchLogin(settings.githubToken)}` };
  } catch (error) {
    return { ok: false, line: `GitHub: ${githubFailureReason(error)}` };
  }
}

async function testServer(settings: Settings): Promise<{ ok: boolean; line: string }> {
  if (settings.serverUrl === '' || settings.passphrase === '') {
    return { ok: false, line: 'Server: no URL or passphrase yet' };
  }
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
