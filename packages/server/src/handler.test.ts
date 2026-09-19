import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSPHRASE_HEADER, PR_QUESTIONS } from '../../core/src/index.js';
import type { AskResponse, PrSignals, Verdict } from '../../core/src/index.js';
import { handleAsk, jevRequest } from './handler.js';
import type { AskDeps } from './handler.js';

const PASSPHRASE = 'open sesame';
/** Stands in for provider text. No response body may ever contain it. */
const SECRET_TEXT = 'provider-secret-detail-9f3a';

function signals(overrides: Partial<PrSignals> = {}): PrSignals {
  return {
    ci: 'passing',
    linesChanged: 40,
    filesChanged: 3,
    docsOnly: false,
    testsTouched: true,
    approvals: 1,
    changesRequested: 0,
    isDraft: false,
    authorIsBot: false,
    ...overrides,
  };
}

interface RequestOptions {
  /** The passphrase header. null leaves the header out. */
  key?: string | null;
  /** Sent as JSON unless it is already a string. */
  body?: unknown;
}

function makeRequest({ key = PASSPHRASE, body = { kind: 'pr', signals: signals() } }: RequestOptions = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set(PASSPHRASE_HEADER, key);
  return new Request('https://magic-jev.test/api/ask', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function decideReturning(verdict: Verdict) {
  return vi.fn<NonNullable<AskDeps['decide']>>(async () => verdict);
}

function decideThrowing(error: unknown) {
  return vi.fn<NonNullable<AskDeps['decide']>>(async () => {
    throw error;
  });
}

function apiCallError(statusCode: number, responseBody = SECRET_TEXT): APICallError {
  return new APICallError({
    message: SECRET_TEXT,
    url: 'https://gateway.test/v1/evaluate',
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

async function readJson(response: Response): Promise<{ parsed: AskResponse; text: string }> {
  const text = await response.text();
  return { parsed: JSON.parse(text) as AskResponse, text };
}

beforeEach(() => {
  // The handler logs model failures for the server owner. Keep the test output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('handleAsk: passphrase', () => {
  it('lets the right passphrase through', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest(), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong passphrase without calling decide', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest({ key: 'open sesamf' }), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(401);
    expect((await readJson(response)).parsed).toEqual({ ok: false, error: 'unauthorized', message: expect.any(String) });
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses a passphrase that only shares a prefix', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest({ key: 'open' }), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses a missing header without calling decide', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest({ key: null }), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses everything when no passphrase is configured', async () => {
    vi.stubEnv('ASK_PASSPHRASE', '');
    const decide = decideReturning('yes');
    for (const key of [PASSPHRASE, '', null]) {
      const response = await handleAsk(makeRequest({ key }), { decide });
      expect(response.status).toBe(401);
    }
    const explicit = await handleAsk(makeRequest({ key: '' }), { decide, passphrase: '' });
    expect(explicit.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('reads ASK_PASSPHRASE from the environment by default', async () => {
    vi.stubEnv('ASK_PASSPHRASE', 'from the environment');
    const decide = decideReturning('no');
    const response = await handleAsk(makeRequest({ key: 'from the environment' }), { decide });
    expect(response.status).toBe(200);
  });

  it('checks the passphrase before it reads the body', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest({ key: 'wrong', body: 'not json' }), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(401);
  });
});

describe('handleAsk: the open, hosted mode', () => {
  it('needs no passphrase when open, and ignores one that is sent', async () => {
    const decide = decideReturning('yes');
    expect((await handleAsk(makeRequest({ key: null }), { decide, open: true, passphrase: undefined })).status).toBe(200);
    expect((await handleAsk(makeRequest({ key: 'anything' }), { decide, open: true, passphrase: PASSPHRASE })).status).toBe(200);
  });

  it('still refuses everything when neither open nor a passphrase is configured', async () => {
    const decide = decideReturning('yes');
    const response = await handleAsk(makeRequest({ key: null }), { decide, open: false, passphrase: undefined });
    expect(response.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('reads ASK_OPEN from the environment, and only the word true', async () => {
    const decide = decideReturning('yes');
    vi.stubEnv('ASK_PASSPHRASE', '');
    vi.stubEnv('ASK_OPEN', 'true');
    expect((await handleAsk(makeRequest({ key: null }), { decide })).status).toBe(200);
    vi.stubEnv('ASK_OPEN', '1');
    expect((await handleAsk(makeRequest({ key: null }), { decide })).status).toBe(401);
  });

  it('refuses a caller over the limit with 429, before the body is read or Jev is asked', async () => {
    const decide = decideReturning('yes');
    const allow = vi.fn((caller: string) => caller !== '203.0.113.9');
    const from = (ip: string) => {
      const request = makeRequest({ key: null, body: '{not json' });
      request.headers.set('x-forwarded-for', `${ip}, 10.0.0.1`);
      return request;
    };
    const refused = await handleAsk(from('203.0.113.9'), { decide, open: true, allow });
    expect(refused.status).toBe(429);
    expect((await readJson(refused)).parsed).toEqual({
      ok: false,
      error: 'rate_limited',
      message: 'Too many asks. Try again in a minute.',
    });
    // Someone else is judged on their own address: the first one in x-forwarded-for.
    expect((await handleAsk(from('198.51.100.7'), { decide, open: true, allow })).status).toBe(400);
    expect(allow.mock.calls.map(([caller]) => caller)).toEqual(['203.0.113.9', '198.51.100.7']);
    expect(decide).not.toHaveBeenCalled();
  });

  it('does not limit a request with no address, which only happens off Vercel', async () => {
    const allow = vi.fn(() => false);
    const response = await handleAsk(makeRequest({ key: null }), { decide: decideReturning('yes'), open: true, allow });
    expect(response.status).toBe(200);
    expect(allow).not.toHaveBeenCalled();
  });
});

describe('handleAsk: bad bodies', () => {
  const cases: Array<[name: string, body: unknown, path: string | null]> = [
    ['a body that is not JSON', '{ nope', null],
    ['a body that is not an object', '[]', null],
    ['an unknown top-level key', { kind: 'pr', signals: signals(), criteria: { yes: 'always' } }, 'criteria'],
    ['an unknown signal', { kind: 'pr', signals: { ...signals(), mood: 'good' } }, 'signals.mood'],
    ['a missing signal', { kind: 'pr', signals: { ...signals(), isDraft: undefined } }, 'signals.isDraft'],
    ['a negative count', { kind: 'pr', signals: signals({ linesChanged: -1 }) }, 'signals.linesChanged'],
    ['a fractional count', { kind: 'pr', signals: signals({ approvals: 1.5 }) }, 'signals.approvals'],
    ['a count that is a string', { kind: 'pr', signals: { ...signals(), filesChanged: '3' } }, 'signals.filesChanged'],
    ['a bad ci value', { kind: 'pr', signals: { ...signals(), ci: 'green' } }, 'signals.ci'],
    ['a bad kind', { kind: 'invite', signals: signals() }, 'kind'],
  ];

  for (const [name, body, path] of cases) {
    it(`answers 400 for ${name}`, async () => {
      const decide = decideReturning('yes');
      const response = await handleAsk(makeRequest({ body }), { decide, passphrase: PASSPHRASE });
      expect(response.status).toBe(400);
      const { parsed } = await readJson(response);
      expect(parsed).toEqual({ ok: false, error: 'bad_request', message: expect.any(String) });
      if (!parsed.ok && path !== null) expect(parsed.message).toContain(path);
      if (!parsed.ok) expect(parsed.message.length).toBeLessThan(120);
      expect(decide).not.toHaveBeenCalled();
    });
  }

  it('answers 400 for a count too large to be an exact integer', async () => {
    const body = `{"kind":"pr","signals":${JSON.stringify(signals()).replace('"linesChanged":40', '"linesChanged":1e400')}}`;
    const response = await handleAsk(makeRequest({ body }), { decide: decideReturning('yes'), passphrase: PASSPHRASE });
    expect(response.status).toBe(400);
  });
});

describe('handleAsk: success', () => {
  it('answers with the verdict and a rounded latency', async () => {
    const decide = decideReturning('lean_yes');
    const response = await handleAsk(makeRequest(), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(200);
    const { parsed } = await readJson(response);
    expect(parsed).toEqual({ ok: true, verdict: 'lean_yes', latencyMs: expect.any(Number) });
    if (parsed.ok) {
      expect(Number.isInteger(parsed.latencyMs)).toBe(true);
      expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives decide exactly the signals it was sent, and a live abort signal', async () => {
    const sent = signals({ ci: 'pending', linesChanged: 412, approvals: 2 });
    const decide = decideReturning('unclear');
    await handleAsk(makeRequest({ body: { kind: 'pr', signals: sent } }), { decide, passphrase: PASSPHRASE });
    const [received, abortSignal] = decide.mock.calls[0]!;
    expect(received).toEqual(sent);
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(abortSignal.aborted).toBe(false);
  });

  it('treats a verdict outside VERDICTS as a model error', async () => {
    const decide = vi.fn(async () => 'maybe' as Verdict);
    const response = await handleAsk(makeRequest(), { decide, passphrase: PASSPHRASE });
    expect(response.status).toBe(502);
    expect((await readJson(response)).parsed).toEqual({ ok: false, error: 'model_error', message: 'The model call failed.' });
  });
});

describe('handleAsk: error mapping', () => {
  async function ask(deps: AskDeps) {
    const response = await handleAsk(makeRequest(), { passphrase: PASSPHRASE, ...deps });
    return { response, ...(await readJson(response)) };
  }

  it('maps an APICallError with status 402 to out_of_credits', async () => {
    const { response, parsed } = await ask({ decide: decideThrowing(apiCallError(402)) });
    expect(response.status).toBe(402);
    expect(parsed).toMatchObject({ ok: false, error: 'out_of_credits' });
  });

  it('maps quota_for_entity_exceeded text to out_of_credits', async () => {
    const error = apiCallError(400, `{"error":{"code":"quota_for_entity_exceeded","message":"${SECRET_TEXT}"}}`);
    const { response, parsed } = await ask({ decide: decideThrowing(error) });
    expect(response.status).toBe(402);
    expect(parsed).toMatchObject({ ok: false, error: 'out_of_credits' });
  });

  it('maps insufficient credit wording to out_of_credits', async () => {
    const error = new Error(`Insufficient funds. Please add credits to your account. ${SECRET_TEXT}`);
    const { response, parsed } = await ask({ decide: decideThrowing(error) });
    expect(response.status).toBe(402);
    expect(parsed).toMatchObject({ ok: false, error: 'out_of_credits' });
  });

  it('maps status 429 to rate_limited', async () => {
    const { response, parsed } = await ask({ decide: decideThrowing(apiCallError(429)) });
    expect(response.status).toBe(429);
    expect(parsed).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('reads the status from a Gateway style error that is not an APICallError', async () => {
    // The Gateway provider throws its own GatewayError classes. They carry statusCode and are not APICallError.
    const gatewayError = Object.assign(new Error(SECRET_TEXT), { name: 'GatewayRateLimitError', statusCode: 429 });
    const { response, parsed } = await ask({ decide: decideThrowing(gatewayError) });
    expect(response.status).toBe(429);
    expect(parsed).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('reads the status from a wrapped cause', async () => {
    const wrapped = new Error(`retry wrapper ${SECRET_TEXT}`, { cause: apiCallError(402) });
    const { response } = await ask({ decide: decideThrowing(wrapped) });
    expect(response.status).toBe(402);
  });

  it('maps a timeout to model_error with the timeout message', async () => {
    const decide = vi.fn<NonNullable<AskDeps['decide']>>(
      (_signals, abortSignal) =>
        new Promise<Verdict>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error(`aborted ${SECRET_TEXT}`)));
        }),
    );
    const { response, parsed } = await ask({ decide, timeoutMs: 20 });
    expect(response.status).toBe(502);
    expect(parsed).toEqual({ ok: false, error: 'model_error', message: 'Jev did not answer in time.' });
  });

  it('asks once more when the first attempt hangs, and answers from the second', async () => {
    // Measured live: about 1 call in 30 to Jev never comes back. A second attempt does.
    let calls = 0;
    const decide = vi.fn<NonNullable<AskDeps['decide']>>((_signals, abortSignal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve('lean_yes');
      return new Promise<Verdict>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const { response, parsed } = await ask({ decide, timeoutMs: 20 });
    expect(response.status).toBe(200);
    expect(parsed).toMatchObject({ ok: true, verdict: 'lean_yes' });
    expect(decide).toHaveBeenCalledTimes(2);
    // Each attempt gets its own abort signal, and the first one was aborted.
    expect(decide.mock.calls[0][1].aborted).toBe(true);
    expect(decide.mock.calls[1][1].aborted).toBe(false);
    // The latency is everything the caller waited for, the hung attempt included.
    if (parsed.ok) expect(parsed.latencyMs).toBeGreaterThanOrEqual(15);
  });

  it('gives up after two hung attempts', async () => {
    const decide = vi.fn<NonNullable<AskDeps['decide']>>(() => new Promise<Verdict>(() => {}));
    const { response } = await ask({ decide, timeoutMs: 20 });
    expect(response.status).toBe(502);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('does not ask again after a real failure, only after a hang', async () => {
    const decide = decideThrowing(apiCallError(402));
    const { response } = await ask({ decide });
    expect(response.status).toBe(402);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('still answers in time when decide ignores the abort signal', async () => {
    const decide = vi.fn<NonNullable<AskDeps['decide']>>(() => new Promise<Verdict>(() => {}));
    const started = performance.now();
    const { response, parsed } = await ask({ decide, timeoutMs: 20 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.status).toBe(502);
    expect(parsed).toMatchObject({ message: 'Jev did not answer in time.' });
  });

  it('maps anything else to model_error with the fixed message', async () => {
    for (const thrown of [new Error(SECRET_TEXT), apiCallError(500), SECRET_TEXT, null]) {
      const { response, parsed } = await ask({ decide: decideThrowing(thrown) });
      expect(response.status).toBe(502);
      expect(parsed).toEqual({ ok: false, error: 'model_error', message: 'The model call failed.' });
    }
  });

  it('never puts the thrown error text in a response body', async () => {
    const thrown = [
      apiCallError(402),
      apiCallError(429),
      apiCallError(500),
      new Error(SECRET_TEXT),
      new Error(`insufficient credit ${SECRET_TEXT}`),
      new Error('outer', { cause: new Error(SECRET_TEXT) }),
    ];
    for (const error of thrown) {
      const { text } = await ask({ decide: decideThrowing(error) });
      expect(text).not.toContain(SECRET_TEXT);
    }
  });
});

describe('handleAsk: response headers', () => {
  it('sends JSON with cache-control no-store on every kind of response', async () => {
    const responses = await Promise.all([
      handleAsk(makeRequest(), { decide: decideReturning('yes'), passphrase: PASSPHRASE }),
      handleAsk(makeRequest({ key: 'wrong' }), { decide: decideReturning('yes'), passphrase: PASSPHRASE }),
      handleAsk(makeRequest({ body: 'nope' }), { decide: decideReturning('yes'), passphrase: PASSPHRASE }),
      handleAsk(makeRequest(), { decide: decideThrowing(new Error('x')), passphrase: PASSPHRASE }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 401, 400, 502]);
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });
});

describe('jevRequest', () => {
  it('sends the questions from core, the Jev model, the signals as state, and no retries', () => {
    const sent = signals({ linesChanged: 301 });
    const request = jevRequest(sent);
    expect(request.questions).toBe(PR_QUESTIONS);
    expect(request.model).toBe('typesafe-ai/jev');
    expect(request.state).toEqual(sent);
    expect(request.maxRetries).toBe(0);
    expect(Object.keys(request).sort()).toEqual(['maxRetries', 'model', 'questions', 'state']);
  });

  it('copies the signals rather than sharing the object', () => {
    const sent = signals();
    expect(jevRequest(sent).state).not.toBe(sent);
  });
});
