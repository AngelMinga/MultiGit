// Tests de la extensión dentro de un VS Code real (@vscode/test-cli).
// Crea un workspace temporal con 3 repos: mftheme y shell en dev-x, mflogin en develop (desalineado);
// mftheme con un cambio y shell con un archivo sin versionar.
import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const workspace = mkdtempSync(path.join(tmpdir(), 'multigit-e2e-'));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env });

for (const [name, branch] of [
  ['mftheme', 'dev-x'],
  ['shell', 'dev-x'],
  ['mflogin', 'develop'],
]) {
  const root = path.join(workspace, name);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(workspace, 'init', '-q', '-b', 'develop', root);
  writeFileSync(path.join(root, 'package.json'), `{ "name": "${name}" }\n`);
  writeFileSync(path.join(root, 'src', 'index.js'), `export const name = '${name}';\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', `feat: ${name} inicial`);
  if (branch !== 'develop') git(root, 'checkout', '-q', '-b', branch);
}
writeFileSync(path.join(workspace, 'mftheme', 'src', 'index.js'), "export const name = 'mftheme-v2';\n");
writeFileSync(path.join(workspace, 'shell', 'nuevo.js'), 'export {};\n');

export default defineConfig({
  files: 'out-e2e/**/*.test.js',
  workspaceFolder: workspace,
  mocha: { ui: 'bdd', timeout: 60_000 },
  // Sin otras extensiones del usuario (sí las integradas, como vscode.git).
  launchArgs: ['--disable-extensions'],
});
