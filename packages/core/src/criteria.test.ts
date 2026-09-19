import { describe, expect, it } from 'vitest';
import { PR_CRITERIA, PR_INSTRUCTIONS, PR_QUESTIONS, expectedVerdict } from './criteria.js';
import { VERDICTS, type PrSignals } from './types.js';

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

describe('expectedVerdict', () => {
  it('follows the size thresholds when CI is passing', () => {
    const table: Array<[number, string]> = [
      [0, 'yes'],
      [50, 'yes'],
      [51, 'lean_yes'],
      [300, 'lean_yes'],
      [301, 'unclear'],
      [800, 'unclear'],
      [801, 'no'],
    ];
    for (const [linesChanged, verdict] of table) {
      expect(expectedVerdict(signals({ linesChanged })), `${linesChanged} lines`).toBe(verdict);
    }
  });

  it('says yes to a docs-only pull request of any size', () => {
    expect(expectedVerdict(signals({ docsOnly: true, linesChanged: 5000 }))).toBe('yes');
  });

  it('says no to failing CI, a draft, or changes requested, regardless of size', () => {
    for (const linesChanged of [1, 200, 5000]) {
      for (const docsOnly of [false, true]) {
        expect(expectedVerdict(signals({ ci: 'failing', linesChanged, docsOnly }))).toBe('no');
        expect(expectedVerdict(signals({ isDraft: true, linesChanged, docsOnly }))).toBe('no');
        expect(expectedVerdict(signals({ changesRequested: 1, linesChanged, docsOnly }))).toBe('no');
      }
    }
  });

  it('says unclear when CI is pending or absent', () => {
    expect(expectedVerdict(signals({ ci: 'pending' }))).toBe('unclear');
    expect(expectedVerdict(signals({ ci: 'none' }))).toBe('unclear');
    expect(expectedVerdict(signals({ ci: 'pending', docsOnly: true }))).toBe('unclear');
    expect(expectedVerdict(signals({ ci: 'none', linesChanged: 600 }))).toBe('unclear');
  });

  it('lets no beat unclear', () => {
    expect(expectedVerdict(signals({ ci: 'pending', isDraft: true }))).toBe('no');
    expect(expectedVerdict(signals({ ci: 'none', linesChanged: 801 }))).toBe('no');
    expect(expectedVerdict(signals({ ci: 'pending', changesRequested: 2 }))).toBe('no');
  });

  it('ignores the signals that are not part of the rule', () => {
    const base = signals({ linesChanged: 120 });
    expect(expectedVerdict({ ...base, authorIsBot: true })).toBe('lean_yes');
    expect(expectedVerdict({ ...base, approvals: 3 })).toBe('lean_yes');
    expect(expectedVerdict({ ...base, testsTouched: true, filesChanged: 40 })).toBe('lean_yes');
  });
});

describe('PR_CRITERIA', () => {
  it('has a non-empty criterion for every verdict and nothing else', () => {
    expect(Object.keys(PR_CRITERIA).sort()).toEqual([...VERDICTS].sort());
    for (const verdict of VERDICTS) {
      expect(PR_CRITERIA[verdict].trim().length, verdict).toBeGreaterThan(0);
    }
  });

  it('mentions the numbers each criterion depends on', () => {
    expect(PR_CRITERIA.no).toContain('800');
    expect(PR_CRITERIA.unclear).toContain('301');
    expect(PR_CRITERIA.unclear).toContain('800');
    expect(PR_CRITERIA.yes).toContain('50');
    expect(PR_CRITERIA.lean_yes).toContain('51');
    expect(PR_CRITERIA.lean_yes).toContain('300');
  });

  it('names the signal fields each criterion depends on', () => {
    for (const field of ['ci', 'isDraft', 'changesRequested', 'docsOnly', 'linesChanged']) {
      expect(PR_CRITERIA.no, field).toContain(field);
      expect(PR_CRITERIA.yes, field).toContain(field);
      expect(PR_CRITERIA.lean_yes, field).toContain(field);
    }
    for (const field of ['ci', 'docsOnly', 'linesChanged']) {
      expect(PR_CRITERIA.unclear, field).toContain(field);
    }
  });

  it('contains no em dashes', () => {
    for (const text of [PR_INSTRUCTIONS, ...Object.values(PR_CRITERIA)]) {
      expect(text).not.toContain('—');
    }
  });
});

describe('PR_INSTRUCTIONS', () => {
  it('names every signal field', () => {
    const fields: Array<keyof PrSignals> = [
      'ci',
      'linesChanged',
      'filesChanged',
      'docsOnly',
      'testsTouched',
      'approvals',
      'changesRequested',
      'isDraft',
      'authorIsBot',
    ];
    for (const field of fields) {
      expect(PR_INSTRUCTIONS, field).toContain(field);
    }
  });
});

describe('PR_QUESTIONS', () => {
  it('is one choice question built from the instructions and criteria', () => {
    expect(PR_QUESTIONS).toEqual({
      verdict: { type: 'choice', instructions: PR_INSTRUCTIONS, criteria: PR_CRITERIA },
    });
    expect(Object.keys(PR_QUESTIONS)).toEqual(['verdict']);
  });
});
