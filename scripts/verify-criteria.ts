/**
 * The live check. It posts a table of about 40 signal sets to the deployed
 * /api/ask and reports how often Jev agrees with expectedVerdict, and where
 * the misses are. The bar: at least 90 percent agreement, and no miss further
 * than 10 percent from a size threshold.
 *
 *   MAGIC_JEV_URL=https://... MAGIC_JEV_KEY=... corepack pnpm verify:criteria
 *
 * Exit codes: 0 the bar is met, 2 it is not, 1 the check could not run.
 */
import { pathToFileURL } from 'node:url';
import { PASSPHRASE_HEADER, expectedVerdict } from '../packages/core/src/index.js';
import type { AskRequest, AskResponse, PrSignals, Verdict } from '../packages/core/src/index.js';

/** The size thresholds named in the criteria, in lines changed. */
const THRESHOLDS = [50, 300, 800] as const;
const PASS_RATE_PERCENT = 90;
const MAX_MISS_DISTANCE_PERCENT = 10;
const REQUEST_TIMEOUT_MS = 15_000;

export interface Case {
  name: string;
  signals: PrSignals;
}

function signals(overrides: Partial<PrSignals>): PrSignals {
  return {
    ci: 'passing',
    linesChanged: 40,
    filesChanged: 4,
    docsOnly: false,
    testsTouched: true,
    approvals: 0,
    changesRequested: 0,
    isDraft: false,
    authorIsBot: false,
    ...overrides,
  };
}

export function buildCases(): Case[] {
  const cases: Case[] = [];
  const add = (name: string, overrides: Partial<PrSignals>) => cases.push({ name, signals: signals(overrides) });

  // Each threshold: 10 percent below, just below, at, just above, 10 percent above. CI passing.
  for (const threshold of THRESHOLDS) {
    const tenth = threshold / 10;
    for (const lines of [threshold - tenth, threshold - 1, threshold, threshold + 1, threshold + tenth]) {
      add(`${lines} lines, CI passing`, { linesChanged: lines });
    }
  }

  for (const lines of [40, 500, 5000]) {
    add(`docs only, ${lines} lines`, { docsOnly: true, testsTouched: false, linesChanged: lines });
  }

  for (const ci of ['failing', 'pending', 'none'] as const) {
    for (const lines of [30, 600]) add(`CI ${ci}, ${lines} lines`, { ci, linesChanged: lines });
  }

  add('draft, 30 lines', { isDraft: true, linesChanged: 30 });
  add('draft, 200 lines, CI pending', { isDraft: true, ci: 'pending', linesChanged: 200 });
  add('changes requested by 1, 30 lines', { changesRequested: 1, linesChanged: 30 });
  add('changes requested by 2 with 1 approval, 200 lines', { changesRequested: 2, approvals: 1, linesChanged: 200 });

  add('bot author, 20 lines', { authorIsBot: true, linesChanged: 20 });
  add('bot author, 1200 lines', { authorIsBot: true, linesChanged: 1200 });

  for (const approvals of [0, 3]) {
    add(`${approvals} approvals, 120 lines`, { approvals, linesChanged: 120 });
    add(`${approvals} approvals, 500 lines`, { approvals, linesChanged: 500 });
  }

  // Signals that must not move the verdict, and conditions that overlap.
  add('docs only, 40 lines, CI failing', { docsOnly: true, testsTouched: false, ci: 'failing' });
  add('docs only, 2000 lines, CI pending', { docsOnly: true, testsTouched: false, ci: 'pending', linesChanged: 2000 });
  add('docs only draft, 40 lines', { docsOnly: true, testsTouched: false, isDraft: true });
  add('no tests touched, 120 lines', { testsTouched: false, linesChanged: 120 });
  add('3 approvals, 2500 lines', { approvals: 3, linesChanged: 2500 });
  add('3 approvals, CI failing, 30 lines', { approvals: 3, ci: 'failing', linesChanged: 30 });
  add('1 line in 1 file', { linesChanged: 1, filesChanged: 1 });
  add('60 files, 200 lines', { filesChanged: 60, linesChanged: 200 });

  return cases;
}

/**
 * How far a case sits from the nearest size threshold, as a percentage of that
 * threshold. It is null when size is not what decides the verdict (CI is not
 * passing, a draft, changes requested, or docs only): a miss there cannot be
 * excused as a near-threshold slip.
 */
export function thresholdDistancePercent(s: PrSignals): number | null {
  const sizeDecides = s.ci === 'passing' && !s.isDraft && s.changesRequested === 0 && !s.docsOnly;
  if (!sizeDecides) return null;
  return Math.min(...THRESHOLDS.map((threshold) => (Math.abs(s.linesChanged - threshold) / threshold) * 100));
}

/** True when a miss is close enough to a threshold to be tolerated. Integer arithmetic, so exactly 10 percent counts as near. */
export function isNearThreshold(s: PrSignals): boolean {
  if (thresholdDistancePercent(s) === null) return false;
  return THRESHOLDS.some(
    (threshold) => Math.abs(s.linesChanged - threshold) * 100 <= MAX_MISS_DISTANCE_PERCENT * threshold,
  );
}

type Outcome =
  | { kind: 'answer'; verdict: Verdict; latencyMs: number }
  | { kind: 'error'; label: string; fatal: boolean };

/**
 * The server's origin, or a plain-words complaint. The passphrase travels in a
 * header, so only https is accepted, or http on this machine. This is the same
 * rule the extension's options page applies.
 */
export function serverOrigin(value: string): { origin: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { problem: 'MAGIC_JEV_URL is not a URL. It should look like https://magic-jev.vercel.app' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { problem: 'MAGIC_JEV_URL must start with https://, so the passphrase is never sent in the clear.' };
  }
  return { origin: url.origin };
}

export async function ask(url: string, key: string, request: AskRequest, fetchFn: typeof fetch = fetch): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetchFn(`${url}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PASSPHRASE_HEADER]: key },
      body: JSON.stringify(request),
      // Node resends custom headers when it follows a redirect. The passphrase goes to this origin only.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { kind: 'error', label: `could not reach ${url}/api/ask (${why})`, fatal: true };
  }

  let body: AskResponse;
  try {
    body = (await response.json()) as AskResponse;
  } catch {
    return { kind: 'error', label: `HTTP ${response.status}, body is not JSON`, fatal: response.status === 404 };
  }
  if (body.ok) return { kind: 'answer', verdict: body.verdict, latencyMs: body.latencyMs };
  // A rejected passphrase or a refused body will not get better on the next case.
  const fatal = body.error === 'unauthorized' || body.error === 'bad_request' || body.error === 'out_of_credits';
  return { kind: 'error', label: `${body.error}: ${body.message}`, fatal };
}

async function main(): Promise<number> {
  const rawUrl = process.env.MAGIC_JEV_URL?.trim();
  const key = process.env.MAGIC_JEV_KEY?.trim();
  if (!rawUrl || !key) {
    console.error(
      'verify-criteria needs two environment variables:\n' +
        '  MAGIC_JEV_URL  the origin of the deployed server, for example https://magic-jev.vercel.app\n' +
        '  MAGIC_JEV_KEY  the passphrase, the same value as ASK_PASSPHRASE on the deployment\n' +
        `Missing: ${[!rawUrl && 'MAGIC_JEV_URL', !key && 'MAGIC_JEV_KEY'].filter(Boolean).join(', ')}`,
    );
    return 1;
  }
  const server = serverOrigin(rawUrl);
  if ('problem' in server) {
    console.error(server.problem);
    return 1;
  }
  const url = server.origin;

  const cases = buildCases();
  console.log(`Asking ${url}/api/ask about ${cases.length} signal sets, one at a time.\n`);
  console.log(`${'case'.padEnd(52)}${'expected'.padEnd(10)}${'got'.padEnd(10)}${'ms'.padStart(6)}`);

  let hits = 0;
  let errors = 0;
  let farMisses = 0;
  const latencies: number[] = [];

  for (const { name, signals: caseSignals } of cases) {
    const expected = expectedVerdict(caseSignals);
    const outcome = await ask(url, key, { kind: 'pr', signals: caseSignals });

    if (outcome.kind === 'error') {
      errors += 1;
      console.log(`${name.padEnd(52)}${expected.padEnd(10)}ERROR  ${outcome.label}`);
      if (outcome.fatal) {
        console.error('\nStopping: this failure would repeat for every case.');
        return 1;
      }
      continue;
    }

    latencies.push(outcome.latencyMs);
    let note = '';
    if (outcome.verdict === expected) {
      hits += 1;
    } else {
      const distance = thresholdDistancePercent(caseSignals);
      const near = isNearThreshold(caseSignals);
      if (!near) farMisses += 1;
      note =
        distance === null
          ? '  MISS  size is not the deciding signal here'
          : `  MISS  ${distance.toFixed(1)} percent from the nearest threshold${near ? '' : ', too far'}`;
    }
    console.log(
      `${name.padEnd(52)}${expected.padEnd(10)}${outcome.verdict.padEnd(10)}${String(outcome.latencyMs).padStart(6)}${note}`,
    );
  }

  const scorePercent = (hits / cases.length) * 100;
  const averageMs = latencies.length > 0 ? latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length : 0;
  // Integer comparison, so exactly 90 percent meets the bar.
  const scoreMet = hits * 100 >= PASS_RATE_PERCENT * cases.length;
  const met = scoreMet && farMisses === 0 && errors === 0;

  console.log(`\nScore: ${hits} of ${cases.length} (${scorePercent.toFixed(1)} percent). The bar is ${PASS_RATE_PERCENT} percent.`);
  console.log(`Average latency: ${Math.round(averageMs)} ms over ${latencies.length} answers.`);
  console.log(`Misses further than ${MAX_MISS_DISTANCE_PERCENT} percent from a threshold: ${farMisses}.`);
  if (errors > 0) console.log(`Cases that ended in an error: ${errors}. They count against the bar, so run it again.`);
  console.log(met ? 'Bar met.' : 'Bar NOT met. Reword the criteria in packages/core/src/criteria.ts before demoing.');
  return met ? 0 : 2;
}

// Run only as a script, so the case table can be imported without side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error('verify-criteria crashed:', error);
      process.exitCode = 1;
    },
  );
}
