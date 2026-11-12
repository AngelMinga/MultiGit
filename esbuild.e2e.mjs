// Compila los tests de la extensión (test-e2e/*.test.ts → out-e2e/*.test.js).
import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: readdirSync('test-e2e')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test-e2e/${f}`),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outdir: 'out-e2e',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});
