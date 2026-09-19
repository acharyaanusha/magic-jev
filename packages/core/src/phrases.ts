/**
 * The 20 classic Magic 8 Ball phrases, grouped by verdict. Jev picks the
 * verdict and the extension picks a random phrase from that group, which puts
 * back the randomness an 8 Ball should have.
 */
import type { Verdict } from './types.js';

export const PHRASES: Record<Verdict, readonly string[]> = {
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
};

/** What the ball says when anything goes wrong. It is one of the unclear phrases. */
export const HAZY: string = 'Reply hazy, try again';

/** `rng` returns a number in [0, 1), like Math.random. Anything outside that range is clamped. */
export function pickPhrase(verdict: Verdict, rng: () => number = Math.random): string {
  const group = PHRASES[verdict];
  const roll = rng();
  const index = Number.isFinite(roll) ? Math.floor(roll * group.length) : 0;
  const clamped = Math.min(group.length - 1, Math.max(0, index));
  return group[clamped] ?? HAZY;
}
