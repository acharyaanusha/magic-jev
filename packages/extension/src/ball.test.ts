/**
 * The ball itself needs a browser. What can be checked here is the arithmetic
 * that sets a phrase inside the triangle, with the fallback width estimate.
 */
import { describe, expect, it } from 'vitest';
import { PHRASES } from '../../core/src/index.js';
import { CONFETTI_COLORS, TRIANGLE, confettiPieces, estimateWidth, fitPhrase, type PhraseFit } from './ball.js';

const ALL_PHRASES = Object.values(PHRASES).flat();

/** Width of the triangle at a distance from the top of its box. */
function widthAt(fit: PhraseFit, y: number): number {
  const fromApex = fit.orientation === 'up' ? y : TRIANGLE.height - y;
  return (fromApex * TRIANGLE.side) / TRIANGLE.height;
}

describe('fitPhrase', () => {
  it.each(ALL_PHRASES)('sets "%s" inside the triangle', (phrase) => {
    const fit = fitPhrase(phrase);
    expect(fit.lines.length).toBeGreaterThanOrEqual(1);
    expect(fit.lines.length).toBeLessThanOrEqual(3);
    expect(fit.lines.join(' ')).toBe(phrase.toUpperCase());
    expect(fit.fontSize).toBeGreaterThan(4.5);
    expect(fit.fontSize).toBeLessThanOrEqual(TRIANGLE.maxFont);

    const lineBox = fit.fontSize * TRIANGLE.lineHeight;
    fit.lines.forEach((line, i) => {
      const top = fit.tops[i]!;
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + lineBox).toBeLessThanOrEqual(TRIANGLE.height);
      // The tighter of the line's two edges must still hold the text and its side padding.
      const room = Math.min(widthAt(fit, top), widthAt(fit, top + lineBox));
      const needed = estimateWidth(line) * fit.fontSize + 2 * TRIANGLE.sidePad;
      expect(needed).toBeLessThanOrEqual(room + 1e-6);
    });
    // Lines follow one another without overlapping.
    for (let i = 1; i < fit.tops.length; i++) {
      expect(fit.tops[i]! - fit.tops[i - 1]!).toBeCloseTo(lineBox, 6);
    }
  });

  it('sets a single short word on one line at the largest size', () => {
    const fit = fitPhrase('Yes');
    expect(fit.lines).toEqual(['YES']);
    expect(fit.fontSize).toBe(TRIANGLE.maxFont);
  });

  it('points the triangle down when the long word comes first', () => {
    const fit = fitPhrase('Concentrate and ask again');
    expect(fit.orientation).toBe('down');
    expect(fit.lines[0]).toContain('CONCENTRATE');
  });

  it('points the triangle up when the long word comes last', () => {
    expect(fitPhrase('It is certain').orientation).toBe('up');
  });

  it('survives an empty phrase and a very long one', () => {
    expect(fitPhrase('').lines).toEqual(['']);
    const long = fitPhrase('one two three four five six seven eight nine ten eleven twelve');
    expect(long.lines.length).toBeLessThanOrEqual(3);
    expect(long.fontSize).toBeGreaterThan(0);
  });
});

describe('confettiPieces', () => {
  // A fixed sequence stands in for Math.random, so the burst is the same every run.
  const seeded = () => {
    let n = 0;
    return () => ((n += 1) * 0.6180339887) % 1;
  };

  it('throws every piece up and away from the corner the ball sits in', () => {
    const pieces = confettiPieces(28, seeded());
    expect(pieces).toHaveLength(28);
    for (const piece of pieces) {
      // The ball is in the bottom-right corner: up is negative y, and there is no room to the right.
      expect(piece.dy).toBeLessThan(0);
      expect(piece.dx).toBeLessThanOrEqual(40);
      expect(Math.hypot(piece.dx, piece.dy)).toBeGreaterThanOrEqual(80);
      expect(Math.hypot(piece.dx, piece.dy)).toBeLessThanOrEqual(240);
      expect(CONFETTI_COLORS).toContain(piece.color);
    }
  });

  it('is not one clump: the pieces spread over at least 60 degrees', () => {
    const angles = confettiPieces(28, seeded()).map((piece) => Math.atan2(-piece.dy, -piece.dx));
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(Math.PI / 3);
  });
});
