/**
 * The question Jev is asked about a pull request, and the same rule computed
 * locally. Only the server sends these criteria, so a client cannot inject its
 * own. The four criteria are mutually exclusive, and every set of signals
 * matches exactly one of them.
 */
import type { PrSignals, Verdict } from './types.js';

/** Size thresholds, in lines changed. They appear as literal numbers in the criteria text below. */
const SMALL_MAX = 50;
const MEDIUM_MAX = 300;
const LARGE_MAX = 800;

export const PR_INSTRUCTIONS: string = [
  'The state describes one GitHub pull request with these fields:',
  '`ci` is the head commit\'s check result, one of "passing", "failing", "pending" or "none" (no checks exist);',
  '`linesChanged` is additions plus deletions; `filesChanged` is the number of changed files;',
  '`docsOnly` is true when every changed file is documentation;',
  '`testsTouched` is true when any changed path contains "test" or "spec";',
  '`approvals` and `changesRequested` count reviewers whose latest review is an approval or a request for changes;',
  '`isDraft` is true when the pull request is a draft; `authorIsBot` is true when the author is a bot.',
  'The question is whether this pull request can be approved on a light read, without studying the code.',
  'Compare the fields with each criterion exactly as written, treating every number as a hard boundary.',
  'Exactly one criterion matches. Answer with that one verdict only.',
].join(' ');

export const PR_CRITERIA: Record<Verdict, string> = {
  yes:
    '`ci` is "passing", and `isDraft` is false, and `changesRequested` is 0, and either `docsOnly` is true ' +
    '(with any `linesChanged`) or `linesChanged` is at most 50.',
  lean_yes:
    '`ci` is "passing", and `isDraft` is false, and `changesRequested` is 0, and `docsOnly` is false, ' +
    'and `linesChanged` is between 51 and 300 inclusive.',
  unclear:
    'None of the conditions for "no" hold, and either `ci` is "pending" or "none", or `ci` is "passing" ' +
    'with `docsOnly` false and `linesChanged` between 301 and 800 inclusive. This one needs a real read.',
  no:
    '`ci` is "failing", or `isDraft` is true, or `changesRequested` is above 0, or `docsOnly` is false ' +
    'and `linesChanged` is above 800.',
};

export const PR_QUESTIONS: {
  verdict: { type: 'choice'; instructions: string; criteria: Record<Verdict, string> };
} = {
  verdict: { type: 'choice', instructions: PR_INSTRUCTIONS, criteria: PR_CRITERIA },
};

/**
 * The rule in PR_CRITERIA, computed locally. Tests and the live check compare
 * Jev against it. The ball never uses it. Precedence: no, unclear, yes, lean_yes.
 */
export function expectedVerdict(signals: PrSignals): Verdict {
  const { ci, linesChanged, docsOnly, isDraft, changesRequested } = signals;

  if (ci === 'failing' || isDraft || changesRequested > 0 || (!docsOnly && linesChanged > LARGE_MAX)) {
    return 'no';
  }
  // From here on ci is passing, pending or none.
  if (ci !== 'passing' || (!docsOnly && linesChanged > MEDIUM_MAX)) {
    return 'unclear';
  }
  if (docsOnly || linesChanged <= SMALL_MAX) {
    return 'yes';
  }
  return 'lean_yes';
}
