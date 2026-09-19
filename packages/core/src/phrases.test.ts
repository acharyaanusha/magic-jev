import { describe, expect, it } from 'vitest';
import { HAZY, PHRASES, pickPhrase } from './phrases.js';
import { VERDICTS } from './types.js';

describe('PHRASES', () => {
  it('uses the wording in the spec', () => {
    expect(PHRASES).toEqual({
      yes: ['It is certain', 'It is decidedly so', 'Without a doubt', 'Yes definitely', 'You may rely on it'],
      lean_yes: ['As I see it, yes', 'Most likely', 'Outlook good', 'Yes', 'Signs point to yes'],
      unclear: [
        'Reply hazy, try again',
        'Ask again later',
        'Better not tell you now',
        'Cannot predict now',
        'Concentrate and ask again',
      ],
      no: ["Don't count on it", 'My reply is no', 'My sources say no', 'Outlook not so good', 'Very doubtful'],
    });
  });

  it('has five phrases per verdict and 20 distinct phrases in total', () => {
    for (const verdict of VERDICTS) {
      expect(PHRASES[verdict], verdict).toHaveLength(5);
    }
    expect(new Set(VERDICTS.flatMap((verdict) => PHRASES[verdict])).size).toBe(20);
  });
});

describe('HAZY', () => {
  it('is the classic hazy reply, one of the unclear phrases', () => {
    expect(HAZY).toBe('Reply hazy, try again');
    expect(PHRASES.unclear).toContain(HAZY);
  });
});

describe('pickPhrase', () => {
  it('gives the first phrase of the group when rng returns 0 and the last at 0.999', () => {
    for (const verdict of VERDICTS) {
      expect(pickPhrase(verdict, () => 0)).toBe(PHRASES[verdict][0]);
      expect(pickPhrase(verdict, () => 0.999)).toBe(PHRASES[verdict][4]);
    }
  });

  it('maps the middle of the range to the middle phrase', () => {
    expect(pickPhrase('no', () => 0.5)).toBe('My sources say no');
  });

  it('stays inside the group when rng misbehaves', () => {
    expect(pickPhrase('yes', () => 1)).toBe(PHRASES.yes[4]);
    expect(pickPhrase('yes', () => -0.2)).toBe(PHRASES.yes[0]);
    expect(pickPhrase('yes', () => Number.NaN)).toBe(PHRASES.yes[0]);
  });

  it('defaults to Math.random and always returns a phrase from the group', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(PHRASES.lean_yes).toContain(pickPhrase('lean_yes'));
    }
  });
});
