/**
 * Reads a pull request reference out of a github.com pathname. The content
 * script runs on every GitHub page, so this is what decides whether the page
 * is a pull request at all.
 */
import type { PrRef } from './messages.js';

/**
 * Owner, repo, the literal "pull", then a number with no leading zero.
 * Anything after the number must start with a slash, so tabs such as /files
 * match and "12abc" does not. "/pull/new" fails the digits and "/pulls" fails
 * the literal.
 */
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/;

export function parsePrUrl(pathname: string): PrRef | null {
  const match = PR_PATH.exec(pathname);
  if (!match) return null;
  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) return null;
  return { owner, repo, number };
}
