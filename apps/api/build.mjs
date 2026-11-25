/**
 * Bundles the API into dist/index.js for Vercel.
 *
 * Vercel's standard Node builder compiles files one by one and leaves imports
 * as written. @stackd/solana and @stackd/base are workspace packages that ship
 * TypeScript source with extensionless imports, which Node cannot load once
 * compiled. Bundling inlines them, so nothing workspace-shaped is left to
 * resolve at runtime. Every npm dependency stays external: Vercel traces and
 * ships those from node_modules as usual. An external has to resolve from
 * apps/api, so the API lists the npm packages @stackd/base needs (viem, ox)
 * among its own dependencies.
 *
 * vercel.json points the Output Directory at dist, and the Express builder
 * takes dist/index.js as the entrypoint.
 */

import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const deps = (file) => Object.keys(JSON.parse(readFileSync(file, 'utf8')).dependencies ?? {});

const external = [
  ...new Set([
    ...deps('package.json'),
    ...deps('../../packages/solana/package.json'),
    ...deps('../../packages/base/package.json'),
  ]),
].filter((name) => !name.startsWith('@stackd/'));

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
