import { describe, expect, it } from 'vitest';
import { serverUrlSuggestion, tokenNote } from './setup-hints.js';

describe('serverUrlSuggestion', () => {
  it('spots a Vercel address with the ending mistyped', () => {
    expect(serverUrlSuggestion('https://magic-jev.vercel.ap')).toBe('https://magic-jev.vercel.app');
    expect(serverUrlSuggestion('https://magic-jev.vercel.com')).toBe('https://magic-jev.vercel.app');
    expect(serverUrlSuggestion('https://magic-jev.vercel.appp')).toBe('https://magic-jev.vercel.app');
    expect(serverUrlSuggestion('https://magic-jev.vercelapp')).toBeNull();
  });

  it('has nothing to suggest for a good address or one that is not Vercel', () => {
    expect(serverUrlSuggestion('https://magic-jev.vercel.app')).toBeNull();
    expect(serverUrlSuggestion('https://example.com')).toBeNull();
    expect(serverUrlSuggestion('not a url')).toBeNull();
  });
});

describe('tokenNote', () => {
  it('warns about what a fine-grained token cannot read', () => {
    expect(tokenNote('github_pat_11ABC')).toMatch(/only covers repositories you own/);
    expect(tokenNote('github_pat_11ABC')).toMatch(/classic token/);
  });

  it('says nothing about a classic token or an empty field', () => {
    expect(tokenNote('ghp_abc')).toBeNull();
    expect(tokenNote('')).toBeNull();
  });
});
