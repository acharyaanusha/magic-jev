import { describe, expect, it } from 'vitest';
import { parsePrUrl } from './pr-url.js';

describe('parsePrUrl', () => {
  const ref = { owner: 'octo', repo: 'hello-world', number: 12 };

  it('reads the pull request page', () => {
    expect(parsePrUrl('/octo/hello-world/pull/12')).toEqual(ref);
  });

  it.each(['files', 'commits', 'checks'])('reads the /%s tab', (tab) => {
    expect(parsePrUrl(`/octo/hello-world/pull/12/${tab}`)).toEqual(ref);
  });

  it('reads a deeper path under the pull request', () => {
    expect(parsePrUrl('/octo/hello-world/pull/12/commits/abc123')).toEqual(ref);
  });

  it('accepts a trailing slash', () => {
    expect(parsePrUrl('/octo/hello-world/pull/12/')).toEqual(ref);
    expect(parsePrUrl('/octo/hello-world/pull/12/files/')).toEqual(ref);
  });

  it('keeps dots, dashes and underscores in the names', () => {
    expect(parsePrUrl('/my-org/site.github.io_v2/pull/7')).toEqual({
      owner: 'my-org',
      repo: 'site.github.io_v2',
      number: 7,
    });
  });

  it('gives null for /pull/new and /pulls', () => {
    expect(parsePrUrl('/octo/hello-world/pull/new')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/new/my-branch')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pulls')).toBeNull();
    expect(parsePrUrl('/pulls')).toBeNull();
  });

  it('gives null for a non-numeric number', () => {
    expect(parsePrUrl('/octo/hello-world/pull/abc')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/12abc')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/1.5')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/-3')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/0')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/pull/')).toBeNull();
  });

  it('gives null for pages that are not pull requests', () => {
    expect(parsePrUrl('/')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
    expect(parsePrUrl('/octo/hello-world')).toBeNull();
    expect(parsePrUrl('/octo/hello-world/issues/12')).toBeNull();
    expect(parsePrUrl('/octo/pull/12')).toBeNull();
    expect(parsePrUrl('/orgs/octo/hello-world/pull/12')).toBeNull();
  });
});
