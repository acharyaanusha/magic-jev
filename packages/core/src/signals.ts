/**
 * Turns raw GitHub REST payloads into the nine signals Jev is given. All the
 * arithmetic and counting happens here, so Jev only has to compare values
 * against the criteria.
 */
import type { CiState, PrSignals, RawPr } from './types.js';

/** Check run conclusions that mean the run did not succeed. Skipped and neutral are not failures. */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/** Review states that replace a reviewer's earlier verdict. COMMENTED and PENDING do not. */
const DECIDING_REVIEW_STATES: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

const DOC_EXTENSIONS = ['.md', '.mdx', '.txt'] as const;

function ciState(raw: RawPr): CiState {
  const { checkRuns, combinedStatus } = raw;

  const failing =
    checkRuns.some((run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)) ||
    combinedStatus.state === 'failure' ||
    combinedStatus.state === 'error';
  if (failing) return 'failing';

  // GitHub reports state 'pending' with total_count 0 for a commit that has no
  // statuses at all, so the state only counts when there is a status behind it.
  const pending =
    checkRuns.some((run) => run.status !== 'completed') ||
    (combinedStatus.state === 'pending' && combinedStatus.total_count > 0);
  if (pending) return 'pending';

  if (checkRuns.length === 0 && combinedStatus.total_count === 0) return 'none';
  return 'passing';
}

/** A documentation file: a text extension, or any file under a directory named docs. */
function isDocFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (DOC_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  // Only directory segments count, so the last segment (the file's own name) is left out.
  const directories = filename.split('/').slice(0, -1);
  return directories.includes('docs');
}

function isTestFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.includes('test') || lower.includes('spec');
}

/** Counts reviewers by their latest deciding review. Reviews arrive oldest first. */
function countReviews(reviews: RawPr['reviews']): { approvals: number; changesRequested: number } {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (review.user === null) continue;
    if (!DECIDING_REVIEW_STATES.has(review.state)) continue;
    latest.set(review.user.login, review.state);
  }

  let approvals = 0;
  let changesRequested = 0;
  for (const state of latest.values()) {
    if (state === 'APPROVED') approvals += 1;
    else if (state === 'CHANGES_REQUESTED') changesRequested += 1;
  }
  return { approvals, changesRequested };
}

export function buildPrSignals(raw: RawPr): PrSignals {
  const { pull, files } = raw;
  const { approvals, changesRequested } = countReviews(raw.reviews);

  return {
    ci: ciState(raw),
    linesChanged: pull.additions + pull.deletions,
    filesChanged: pull.changed_files,
    // An empty file list proves nothing, so it is not docs-only.
    docsOnly: files.length > 0 && files.every((file) => isDocFile(file.filename)),
    testsTouched: files.some((file) => isTestFile(file.filename)),
    approvals,
    changesRequested,
    isDraft: pull.draft,
    authorIsBot: pull.user.type === 'Bot',
  };
}
