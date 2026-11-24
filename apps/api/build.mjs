/**
 * Bundles the API into dist/index.js for Vercel.
 *
 * Vercel's standard Node builder compiles files one by one and leaves imports
 * as written. @stackd/solana is a workspace package that ships TypeScript
 * source with extensionless imports, which Node cannot load once compiled.
 * Bundling inlines that package, so nothing workspace-shaped is left to
 * resolve at runtime. Every npm dependency stays external: Vercel traces and
 * ships those from node_modules as usual.
 *
 * vercel.json points the Output Directory at dist, and the Express builder
 * takes dist/index.js as the entrypoint.
 */

import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const deps = (file) => Object.keys(JSON.parse(readFileSync(file, 'utf8')).dependencies ?? {});

const external = [
  ...new Set([...deps('package.json'), ...deps('../../packages/solana/package.json')]),
].filter((name) => name !== '@stackd/solana');

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  sourcemap: true,
  logLevel: 'info',
});
