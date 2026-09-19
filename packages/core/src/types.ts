/**
 * The shared contract. The server, the extension and the live check all build
 * against this file. Relative imports in this repo end in `.js` (they resolve
 * to the `.ts` source) so the same code runs under Node ESM on Vercel, vitest,
 * tsx and esbuild.
 */

/** What Jev picks. The extension turns it into one of the 20 classic phrases. */
export const VERDICTS = ['yes', 'lean_yes', 'unclear', 'no'] as const;
export type Verdict = (typeof VERDICTS)[number];

export type CiState = 'passing' | 'failing' | 'pending' | 'none';

/** Exactly what Jev is given about a pull request. Nothing else. */
export interface PrSignals {
  ci: CiState;
  /** additions + deletions */
  linesChanged: number;
  filesChanged: number;
  /** Every changed file is .md, .mdx or .txt, or sits under a docs/ directory. */
  docsOnly: boolean;
  /** Any changed path contains "test" or "spec". */
  testsTouched: boolean;
  /** Reviewers whose latest review is APPROVED. */
  approvals: number;
  /** Reviewers whose latest review is CHANGES_REQUESTED. */
  changesRequested: number;
  isDraft: boolean;
  authorIsBot: boolean;
}

/** The GitHub REST payloads the signals are built from, trimmed to the fields read. */
export interface RawPr {
  /** GET /repos/{owner}/{repo}/pulls/{number} */
  pull: {
    draft: boolean;
    additions: number;
    deletions: number;
    changed_files: number;
    user: { login: string; type: string };
    requested_reviewers: Array<{ login: string }>;
    head: { sha: string };
  };
  /** GET /repos/{owner}/{repo}/pulls/{number}/files (all pages) */
  files: Array<{ filename: string }>;
  /** GET /repos/{owner}/{repo}/pulls/{number}/reviews (all pages), oldest first */
  reviews: Array<{ user: { login: string } | null; state: string }>;
  /** GET /repos/{owner}/{repo}/commits/{sha}/status */
  combinedStatus: { state: string; total_count: number };
  /** GET /repos/{owner}/{repo}/commits/{sha}/check-runs -> check_runs */
  checkRuns: Array<{ status: string; conclusion: string | null }>;
}

export interface AskRequest {
  kind: 'pr';
  signals: PrSignals;
}

export type AskErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'out_of_credits'
  | 'rate_limited'
  | 'model_error';

export type AskResponse =
  | { ok: true; verdict: Verdict; latencyMs: number }
  | { ok: false; error: AskErrorCode; message: string };

/** The header the extension sends the passphrase in. */
export const PASSPHRASE_HEADER = 'x-magic-jev-key';
