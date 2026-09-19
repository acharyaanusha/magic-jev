/**
 * Builds the unpacked extension into packages/extension/dist.
 *   node packages/extension/build.mjs
 * Then chrome://extensions -> Developer mode -> Load unpacked -> that dist folder.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, target: 'chrome120', logLevel: 'info', legalComments: 'none' };
await build({ ...common, entryPoints: [resolve(here, 'src/background.ts')], outfile: resolve(dist, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [resolve(here, 'src/content.ts')], outfile: resolve(dist, 'content.js'), format: 'iife' });
await build({ ...common, entryPoints: [resolve(here, 'src/options.ts')], outfile: resolve(dist, 'options.js'), format: 'iife' });

// manifest.json, options.html, icon-128.png
await cp(resolve(here, 'static'), dist, { recursive: true });
console.log(`built ${dist}`);
