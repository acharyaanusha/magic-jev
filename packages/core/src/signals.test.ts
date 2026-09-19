import { describe, expect, it } from 'vitest';
import { buildPrSignals } from './signals.js';
import type { RawPr } from './types.js';

/** A small, green, human-written pull request. Each test overrides what it cares about. */
function rawPr(overrides: Partial<Omit<RawPr, 'pull'>> & { pull?: Partial<RawPr['pull']> } = {}): RawPr {
  const { pull, ...rest } = overrides;
  return {
    pull: {
      draft: false,
      additions: 30,
      deletions: 12,
      changed_files: 2,
      user: { login: 'octocat', type: 'User' },
      requested_reviewers: [{ login: 'me' }],
      head: { sha: 'abc123' },
      ...pull,
    },
    files: [{ filename: 'src/app.ts' }, { filename: 'src/util.ts' }],
    reviews: [],
    combinedStatus: { state: 'success', total_count: 1 },
    checkRuns: [{ status: 'completed', conclusion: 'success' }],
    ...rest,
  };
}

const review = (login: string | null, state: string) => ({
  user: login === null ? null : { login },
  state,
});

describe('buildPrSignals: size and flags', () => {
  it('adds additions and deletions, and copies the file count and draft flag', () => {
    const signals = buildPrSignals(rawPr({ pull: { additions: 700, deletions: 212, changed_files: 9, draft: true } }));
    expect(signals.linesChanged).toBe(912);
    expect(signals.filesChanged).toBe(9);
    expect(signals.isDraft).toBe(true);
  });

  it('returns exactly the nine signal fields', () => {
    expect(Object.keys(buildPrSignals(rawPr())).sort()).toEqual(
      [
        'approvals',
        'authorIsBot',
        'changesRequested',
        'ci',
        'docsOnly',
        'filesChanged',
        'isDraft',
        'linesChanged',
        'testsTouched',
      ].sort(),
    );
  });

  it('flags a bot author', () => {
    expect(buildPrSignals(rawPr({ pull: { user: { login: 'dependabot[bot]', type: 'Bot' } } })).authorIsBot).toBe(true);
    expect(buildPrSignals(rawPr()).authorIsBot).toBe(false);
  });
});

describe('buildPrSignals: docsOnly', () => {
  it('is true for a docs-only pull request', () => {
    const files = [
      { filename: 'README.md' },
      { filename: 'guide/intro.MDX' },
      { filename: 'NOTES.TXT' },
      { filename: 'docs/diagram.png' },
      { filename: 'packages/api/docs/schema.json' },
    ];
    expect(buildPrSignals(rawPr({ files })).docsOnly).toBe(true);
  });

  it('is false when one .ts file is present', () => {
    const files = [{ filename: 'README.md' }, { filename: 'docs/guide.md' }, { filename: 'src/index.ts' }];
    expect(buildPrSignals(rawPr({ files })).docsOnly).toBe(false);
  });

  it('is false for zero files', () => {
    expect(buildPrSignals(rawPr({ files: [] })).docsOnly).toBe(false);
  });

  it('does not treat a name that merely contains "docs" or ".md" as documentation', () => {
    expect(buildPrSignals(rawPr({ files: [{ filename: 'src/docs-helper.ts' }] })).docsOnly).toBe(false);
    expect(buildPrSignals(rawPr({ files: [{ filename: 'mydocs/run.sh' }] })).docsOnly).toBe(false);
    expect(buildPrSignals(rawPr({ files: [{ filename: 'src/readme.md.ts' }] })).docsOnly).toBe(false);
  });
});

describe('buildPrSignals: testsTouched', () => {
  it('is true when any path contains test or spec, in any case', () => {
    expect(buildPrSignals(rawPr({ files: [{ filename: 'src/a.ts' }, { filename: 'src/a.test.ts' }] })).testsTouched).toBe(true);
    expect(buildPrSignals(rawPr({ files: [{ filename: 'Spec/login_flow.rb' }] })).testsTouched).toBe(true);
    expect(buildPrSignals(rawPr({ files: [{ filename: '__TESTS__/a.js' }] })).testsTouched).toBe(true);
  });

  it('is false otherwise', () => {
    expect(buildPrSignals(rawPr()).testsTouched).toBe(false);
    expect(buildPrSignals(rawPr({ files: [] })).testsTouched).toBe(false);
  });
});

describe('buildPrSignals: ci', () => {
  it('is passing when every check run and the combined status succeeded', () => {
    expect(buildPrSignals(rawPr()).ci).toBe('passing');
  });

  it('is failing for each failing check run conclusion', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      const raw = rawPr({ checkRuns: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion }] });
      expect(buildPrSignals(raw).ci, conclusion).toBe('failing');
    }
  });

  it('is failing for a combined status of failure or error', () => {
    for (const state of ['failure', 'error']) {
      const raw = rawPr({ combinedStatus: { state, total_count: 2 }, checkRuns: [] });
      expect(buildPrSignals(raw).ci, state).toBe('failing');
    }
  });

  it('lets failing beat pending', () => {
    const raw = rawPr({
      checkRuns: [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(buildPrSignals(raw).ci).toBe('failing');

    const mixed = rawPr({
      combinedStatus: { state: 'failure', total_count: 1 },
      checkRuns: [{ status: 'queued', conclusion: null }],
    });
    expect(buildPrSignals(mixed).ci).toBe('failing');
  });

  it('is pending while a check run has not completed', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const raw = rawPr({ checkRuns: [{ status: 'completed', conclusion: 'success' }, { status, conclusion: null }] });
      expect(buildPrSignals(raw).ci, status).toBe('pending');
    }
  });

  it('is pending for a pending combined status that has statuses', () => {
    const raw = rawPr({ combinedStatus: { state: 'pending', total_count: 1 }, checkRuns: [] });
    expect(buildPrSignals(raw).ci).toBe('pending');
  });

  it('is none for a pending combined status with total_count 0 and no check runs', () => {
    const raw = rawPr({ combinedStatus: { state: 'pending', total_count: 0 }, checkRuns: [] });
    expect(buildPrSignals(raw).ci).toBe('none');
  });

  it('is passing when only check runs exist and the empty combined status says pending', () => {
    const raw = rawPr({ combinedStatus: { state: 'pending', total_count: 0 } });
    expect(buildPrSignals(raw).ci).toBe('passing');
  });

  it('is passing when only commit statuses exist', () => {
    const raw = rawPr({ combinedStatus: { state: 'success', total_count: 3 }, checkRuns: [] });
    expect(buildPrSignals(raw).ci).toBe('passing');
  });

  it('treats a skipped or neutral conclusion as passing', () => {
    const raw = rawPr({
      combinedStatus: { state: 'pending', total_count: 0 },
      checkRuns: [
        { status: 'completed', conclusion: 'skipped' },
        { status: 'completed', conclusion: 'neutral' },
      ],
    });
    expect(buildPrSignals(raw).ci).toBe('passing');
  });
});

describe('buildPrSignals: reviews', () => {
  it('counts each reviewer once, by their latest state', () => {
    const reviews = [review('ana', 'APPROVED'), review('ben', 'APPROVED'), review('ana', 'APPROVED')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(2);
    expect(signals.changesRequested).toBe(0);
  });

  it('counts a reviewer who approved then requested changes once, as changes requested', () => {
    const reviews = [review('ana', 'APPROVED'), review('ana', 'CHANGES_REQUESTED')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(0);
    expect(signals.changesRequested).toBe(1);
  });

  it('counts a reviewer who requested changes then approved as an approval', () => {
    const reviews = [review('ana', 'CHANGES_REQUESTED'), review('ana', 'APPROVED')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(1);
    expect(signals.changesRequested).toBe(0);
  });

  it('counts a dismissed approval as nothing', () => {
    const reviews = [review('ana', 'APPROVED'), review('ana', 'DISMISSED')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(0);
    expect(signals.changesRequested).toBe(0);
  });

  it('leaves an approval standing after a later COMMENTED or PENDING review', () => {
    const reviews = [review('ana', 'APPROVED'), review('ana', 'COMMENTED'), review('ana', 'PENDING')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(1);
    expect(signals.changesRequested).toBe(0);
  });

  it('ignores a review whose user is null', () => {
    const reviews = [review(null, 'APPROVED'), review(null, 'CHANGES_REQUESTED'), review('ben', 'APPROVED')];
    const signals = buildPrSignals(rawPr({ reviews }));
    expect(signals.approvals).toBe(1);
    expect(signals.changesRequested).toBe(0);
  });
});
