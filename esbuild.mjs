// Empaqueta el extension host (src/extension.ts → dist/extension.js).
// Uso: node esbuild.mjs [--watch] [--production]
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// El build de producción no genera sourcemap: borra el que haya dejado un build de desarrollo.
if (production) rmSync('dist/extension.js.map', { force: true });

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
