import { describe, expect, it } from 'vitest';
import { reasonFor } from './reason.js';
import type { PrSignals } from './types.js';

function signals(overrides: Partial<PrSignals> = {}): PrSignals {
  return {
    ci: 'passing',
    linesChanged: 40,
    filesChanged: 3,
    docsOnly: false,
    testsTouched: false,
    approvals: 0,
    changesRequested: 0,
    isDraft: false,
    authorIsBot: false,
    ...overrides,
  };
}

describe('reasonFor: no', () => {
  it('leads with CI failing', () => {
    expect(reasonFor(signals({ ci: 'failing', linesChanged: 912 }), 'no')).toBe('CI failing · 912 lines');
  });

  it('leads with draft', () => {
    expect(reasonFor(signals({ isDraft: true, linesChanged: 120 }), 'no')).toBe('draft · 120 lines');
  });

  it('leads with changes requested', () => {
    expect(reasonFor(signals({ changesRequested: 2, linesChanged: 120 }), 'no')).toBe('changes requested · 120 lines');
  });

  it('leads with the size when the size caused it', () => {
    expect(reasonFor(signals({ linesChanged: 801 }), 'no')).toBe('801 lines · CI passing');
  });

  it('keeps the three most decisive causes', () => {
    const all = signals({ ci: 'failing', isDraft: true, changesRequested: 1, linesChanged: 2000 });
    expect(reasonFor(all, 'no')).toBe('CI failing · draft · changes requested');
  });

  it('says docs only instead of a line count for a docs-only draft', () => {
    expect(reasonFor(signals({ isDraft: true, docsOnly: true, linesChanged: 4000 }), 'no')).toBe('draft · docs only');
  });

  it('still tells the truth when Jev says no and no rule caused it', () => {
    expect(reasonFor(signals({ linesChanged: 790 }), 'no')).toBe('790 lines · CI passing');
  });
});

describe('reasonFor: unclear', () => {
  it('leads with CI pending', () => {
    expect(reasonFor(signals({ ci: 'pending', linesChanged: 120 }), 'unclear')).toBe('CI pending · 120 lines');
  });

  it('leads with no CI', () => {
    expect(reasonFor(signals({ ci: 'none', docsOnly: true }), 'unclear')).toBe('no CI · docs only');
  });

  it('leads with the size when CI is passing', () => {
    expect(reasonFor(signals({ linesChanged: 412 }), 'unclear')).toBe('412 lines · CI passing');
  });
});

describe('reasonFor: yes and lean_yes', () => {
  it('yes for a docs-only pull request', () => {
    expect(reasonFor(signals({ docsOnly: true, linesChanged: 5000 }), 'yes')).toBe('docs only · CI passing');
  });

  it('yes for a small pull request', () => {
    expect(reasonFor(signals({ linesChanged: 12 }), 'yes')).toBe('12 lines · CI passing');
  });

  it('lean_yes with approvals', () => {
    expect(reasonFor(signals({ linesChanged: 180, approvals: 2 }), 'lean_yes')).toBe('180 lines · CI passing · 2 approvals');
  });

  it('uses the singular for one approval', () => {
    expect(reasonFor(signals({ linesChanged: 180, approvals: 1 }), 'lean_yes')).toBe('180 lines · CI passing · 1 approval');
  });

  it('uses the singular for one line', () => {
    expect(reasonFor(signals({ linesChanged: 1 }), 'yes')).toBe('1 line · CI passing');
  });

  it('never claims CI is passing when it is not', () => {
    expect(reasonFor(signals({ ci: 'pending', linesChanged: 20 }), 'yes')).toBe('20 lines · CI pending');
  });
});

describe('reasonFor: shape', () => {
  it('never has more than three parts', () => {
    const busy = signals({ ci: 'failing', isDraft: true, changesRequested: 3, linesChanged: 9000, approvals: 4 });
    for (const verdict of ['yes', 'lean_yes', 'unclear', 'no'] as const) {
      expect(reasonFor(busy, verdict).split(' · ').length, verdict).toBeLessThanOrEqual(3);
    }
  });
});
