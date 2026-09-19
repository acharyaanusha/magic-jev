/**
 * Plain-words help for the two places setup goes wrong: a mistyped server
 * address, and a GitHub token that cannot read what the ball needs. Pure
 * functions, so the options page can stay a thin layer over them.
 */

/** "https://x.vercel.ap" -> "https://x.vercel.app". Null when there is nothing to suggest. */
export function serverUrlSuggestion(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const match = /^(.+)\.vercel\.([a-z]+)$/.exec(url.hostname);
  if (!match || match[2] === 'app') return null;
  return `${url.protocol}//${match[1]}.vercel.app`;
}

/**
 * A fine-grained token signs in fine and then fails on the ball: it covers
 * only repositories its owner owns, and GitHub offers it no permission for
 * check runs, which private repositories require. Found the hard way.
 */
export function tokenNote(token: string): string | null {
  if (!token.startsWith('github_pat_')) return null;
  return (
    'This is a fine-grained token. It only covers repositories you own, and it cannot read checks on private ones. ' +
    'A classic token with the repo scope covers every pull request you can open.'
  );
}
