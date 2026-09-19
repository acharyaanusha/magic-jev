import { describe, expect, it } from 'vitest';
import { isWorkerRequest } from './messages.js';

describe('isWorkerRequest', () => {
  it('accepts the two pull request messages with a whole ref', () => {
    expect(isWorkerRequest({ type: 'pr-status', owner: 'octo', repo: 'hello', number: 12 })).toBe(true);
    expect(isWorkerRequest({ type: 'ask', owner: 'octo', repo: 'hello', number: 12 })).toBe(true);
  });

  it('accepts open-options, which needs no ref', () => {
    expect(isWorkerRequest({ type: 'open-options' })).toBe(true);
  });

  it('refuses a pull request message with a broken ref', () => {
    expect(isWorkerRequest({ type: 'ask', owner: '', repo: 'hello', number: 12 })).toBe(false);
    expect(isWorkerRequest({ type: 'ask', owner: 'octo', repo: 'hello', number: 1.5 })).toBe(false);
    expect(isWorkerRequest({ type: 'ask', owner: 'octo', repo: 'hello', number: 0 })).toBe(false);
    expect(isWorkerRequest({ type: 'pr-status', owner: 'octo', repo: 'hello' })).toBe(false);
  });

  it('refuses anything else', () => {
    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest('ask')).toBe(false);
    expect(isWorkerRequest({ type: 'open-tab', url: 'https://example.com' })).toBe(false);
  });
});
