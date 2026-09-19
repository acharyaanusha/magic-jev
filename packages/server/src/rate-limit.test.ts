import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to the limit inside the window, then refuses', () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false]);
  });

  it('counts each caller separately', () => {
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(allow('a')).toBe(true);
    expect(allow('b')).toBe(true);
    expect(allow('a')).toBe(false);
  });

  it('lets a caller back in once old asks leave the window', () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    allow('a');
    now = 600;
    allow('a');
    expect(allow('a')).toBe(false);
    now = 1001; // the first ask has left the window, the second has not
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);
  });

  it('forgets callers that have gone quiet, so memory stays bounded', () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, maxCallers: 2 });
    allow('a');
    allow('b');
    now = 5000;
    allow('c'); // over maxCallers: stale callers are dropped
    expect(allow.size()).toBe(1);
  });
});
