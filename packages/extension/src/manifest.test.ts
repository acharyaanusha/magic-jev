/**
 * The manifest decides which hosts the worker and the options page may call.
 * The options page accepts an https server, or http on this machine, so the
 * manifest has to allow the same or the ball can never reach a local server.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8')) as {
  host_permissions: string[];
};

describe('manifest host_permissions', () => {
  it('allows GitHub and a Vercel deployment', () => {
    expect(manifest.host_permissions).toContain('https://api.github.com/*');
    expect(manifest.host_permissions).toContain('https://*.vercel.app/*');
  });

  it('allows a server on this machine, which the options page accepts over http', () => {
    // A match pattern without a port covers every port, so `vercel dev` on 3000 is included.
    expect(manifest.host_permissions).toContain('http://localhost/*');
    expect(manifest.host_permissions).toContain('http://127.0.0.1/*');
  });
});
