/**
 * The request handler behind POST /api/ask. It checks the passphrase, validates
 * the signals, asks Jev for one verdict and answers with typed JSON. The
 * criteria come from core and never from the request, so a client cannot
 * inject its own. No provider text ever reaches a response.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { experimental_evaluate as evaluate } from 'ai';
import { z } from 'zod';
import { PASSPHRASE_HEADER, PR_QUESTIONS, VERDICTS } from '../../core/src/index.js';
import type { AskErrorCode, AskRequest, AskResponse, PrSignals, Verdict } from '../../core/src/index.js';

export interface AskDeps {
  /** Test seam. Defaults to the real Jev call. */
  decide?: (signals: PrSignals, signal: AbortSignal) => Promise<Verdict>;
  /** Defaults to process.env.ASK_PASSPHRASE. */
  passphrase?: string | undefined;
  /** Per attempt. Default 1500. */
  timeoutMs?: number;
}

/**
 * Jev answers in about 200 ms, but measured live about 1 call in 30 never comes
 * back. A hung attempt is cut off here and asked once more, so the worst case is
 * 3 seconds of shaking, not 5 seconds and a shrug. Only a hang is retried: a
 * real failure (credits, rate limit) would fail the same way again.
 */
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_ATTEMPTS = 2;
const JEV_MODEL = 'typesafe-ai/jev';
const TIMEOUT_MESSAGE = 'Jev did not answer in time.';
const MODEL_FAILED_MESSAGE = 'The model call failed.';

/** A count from GitHub: a finite, non-negative, exact integer. */
const count = z.number().int().min(0);

const askRequestSchema = z.strictObject({
  kind: z.literal('pr'),
  signals: z.strictObject({
    ci: z.enum(['passing', 'failing', 'pending', 'none']),
    linesChanged: count,
    filesChanged: count,
    docsOnly: z.boolean(),
    testsTouched: z.boolean(),
    approvals: count,
    changesRequested: count,
    isDraft: z.boolean(),
    authorIsBot: z.boolean(),
  }),
}) satisfies z.ZodType<AskRequest>;

/**
 * The arguments for `evaluate`, minus the abort signal. It is a pure function
 * so a test can assert that the questions sent are the ones in core.
 */
export function jevRequest(signals: PrSignals) {
  return {
    model: JEV_MODEL,
    state: { ...signals },
    questions: PR_QUESTIONS,
    maxRetries: 0,
  };
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/** The real decider: one evaluate call to Jev through Vercel AI Gateway. */
async function askJev(signals: PrSignals, abortSignal: AbortSignal): Promise<Verdict> {
  const result = await evaluate({ ...jevRequest(signals), abortSignal });
  const choice: unknown = result.answers.verdict.choice;
  if (!isVerdict(choice)) throw new Error('Jev answered with a verdict outside VERDICTS.');
  return choice;
}

function json(status: number, body: AskResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(status: number, error: AskErrorCode, message: string): Response {
  return json(status, { ok: false, error, message });
}

/**
 * Compares two strings in constant time. Both are hashed first so the buffers
 * have equal length, which timingSafeEqual requires, and so the comparison
 * time does not depend on the length of the configured passphrase.
 */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** Names the first thing wrong with a body, as a dotted path. Client values are never echoed, only key names. */
function firstBadPath(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'body';
  const path: PropertyKey[] = [...issue.path];
  if (issue.code === 'unrecognized_keys' && issue.keys[0] !== undefined) path.push(issue.keys[0]);
  if (path.length === 0) return 'body';
  return path.map(String).join('.').slice(0, 60);
}

/**
 * Walks an error and what it wraps (cause, a RetryError's lastError and
 * errors), collecting every HTTP status and every piece of text. The Gateway
 * provider throws its own GatewayError classes, which carry `statusCode` but
 * are not APICallError, so this reads the fields structurally.
 */
function inspectError(error: unknown): { statuses: number[]; text: string } {
  const statuses: number[] = [];
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0 && seen.size < 12) {
    const current = queue.shift();
    if (typeof current === 'string') texts.push(current);
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);

    const fields = current as Record<string, unknown>;
    if (typeof fields.statusCode === 'number') statuses.push(fields.statusCode);
    for (const key of ['message', 'responseBody', 'type', 'code']) {
      if (typeof fields[key] === 'string') texts.push(fields[key]);
    }
    queue.push(fields.cause, fields.lastError);
    if (Array.isArray(fields.errors)) queue.push(...fields.errors);
  }
  return { statuses, text: texts.join('\n') };
}

const OUT_OF_CREDITS_TEXT = /quota_for_entity_exceeded|insufficient[\s_-]*(?:credits?|funds?|balance|quota)/i;

/** Maps a failed model call to a typed response. Nothing from the error is copied into it. */
function modelFailure(error: unknown): Response {
  const { statuses, text } = inspectError(error);
  if (statuses.includes(402) || OUT_OF_CREDITS_TEXT.test(text)) {
    return fail(402, 'out_of_credits', 'The AI Gateway account is out of credits.');
  }
  if (statuses.includes(429)) {
    return fail(429, 'rate_limited', 'Jev is rate limited. Try again shortly.');
  }
  return fail(502, 'model_error', MODEL_FAILED_MESSAGE);
}

/** Logs a model failure for the server owner. The log is the only place provider text goes. */
function logModelFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ask] model call failed: ${name}: ${message}`);
}

export async function handleAsk(request: Request, deps: AskDeps = {}): Promise<Response> {
  // The passphrase comes first, before the body is read. This route spends Gateway credits.
  const configured = 'passphrase' in deps ? deps.passphrase : process.env.ASK_PASSPHRASE;
  const offered = request.headers.get(PASSPHRASE_HEADER);
  if (!configured || offered === null || !safeEqual(offered, configured)) {
    return fail(401, 'unauthorized', 'The passphrase is missing or wrong.');
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return fail(400, 'bad_request', 'The body is not valid JSON.');
  }
  const parsed = askRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'bad_request', `Invalid request at ${firstBadPath(parsed.error)}.`);
  }
  const { signals } = parsed.data;

  const decide = deps.decide ?? askJev;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The clock covers every attempt: the latency reported is what the caller waited for.
  const started = performance.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Racing against the timer means a decider that ignores the abort signal still cannot hang the response.
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });

    try {
      const verdict = await Promise.race([decide(signals, controller.signal), timedOut]);
      const latencyMs = Math.round(performance.now() - started);
      if (!isVerdict(verdict)) throw new Error('The decider answered with a verdict outside VERDICTS.');
      return json(200, { ok: true, verdict, latencyMs });
    } catch (error) {
      // Once our own timer has fired, whatever the call rejected with is a timeout.
      if (controller.signal.aborted) continue;
      logModelFailure(error);
      return modelFailure(error);
    } finally {
      clearTimeout(timer);
    }
  }
  return fail(502, 'model_error', TIMEOUT_MESSAGE);
}
