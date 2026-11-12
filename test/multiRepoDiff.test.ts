import { devNull } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, partialMessage } from '../src/ai/parser';
import { buildMultiRepoDiff, changeStatus, multiRepoInstruction } from '../src/ai/multiRepoDiff';
import { GitService } from '../src/git/GitService';

let base: string;
let a: GitService;
let b: GitService;

function repo(name: string, files: Record<string, string>): GitService {
  const root = path.join(base, name);
  execFileSync('git', ['init', '-q', '-b', 'dev-x', root]);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return new GitService(root);
}

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  base = mkdtempSync(path.join(tmpdir(), 'multigit-ai-'));
  a = repo('mfcomponents', { 'src/otp.js': 'export const a = 1;\n', 'package-lock.json': '{}' });
  b = repo('mftheme', { 'theme.js': 'export const t = 1;\n' });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('diff multi-repo para Claude', () => {
  it('encabezado por repo, estados, archivos nuevos y omitidos', async () => {
    writeFileSync(path.join(a.root, 'src/otp.js'), 'export const a = 2;\n');
    writeFileSync(path.join(a.root, 'src/nuevo.js'), 'export const n = 1;\n');
    writeFileSync(path.join(a.root, 'package-lock.json'), '{"x":1}');
    writeFileSync(path.join(b.root, 'theme.js'), 'export const t = 2;\n');

    const result = await buildMultiRepoDiff([
      { name: 'mfcomponents', root: a.root, branch: 'dev-x', files: await a.getChanges() },
      { name: 'mftheme', root: b.root, branch: 'dev-x', files: await b.getChanges() },
      { name: 'shell', root: b.root, branch: 'dev-x', files: [] },
    ]);
    expect(result.repoCount).toBe(2);
    expect(result.fileCount).toBe(4);
    expect(result.diff).toContain('## Repository: mfcomponents (branch dev-x)');
    expect(result.diff).toContain('## Repository: mftheme (branch dev-x)');
    expect(result.diff).not.toContain('shell');
    expect(result.diff).toContain('### MODIFIED: src/otp.js');
    expect(result.diff).toContain('+export const a = 2;');
    expect(result.diff).toContain('### NEW: src/nuevo.js');
    expect(result.diff).toContain('+export const n = 1;');
    expect(result.diff).toContain('[lock file: content omitted]');
  });

  it('un solo repo: sin encabezado de repositorio', async () => {
    const result = await buildMultiRepoDiff([{ name: 'mftheme', root: b.root, branch: 'dev-x', files: await b.getChanges() }]);
    expect(result.diff).not.toContain('## Repository');
    expect(result.diff).toContain('### MODIFIED: theme.js');
  });

  it('estado e instrucción multi-repo', () => {
    expect(changeStatus({ path: 'x', index: '?', worktree: '?', kind: 'untracked', status: '?' })).toBe('NEW');
    expect(changeStatus({ path: 'x', index: 'R', worktree: '.', kind: 'tracked', status: 'R', origPath: 'y' })).toBe('MOVED/RENAMED');
    expect(multiRepoInstruction(['a'])).toBeNull();
    expect(multiRepoInstruction(['a', 'b'])).toContain('SAME message');
  });

  it('parser de la respuesta de Claude (módulo copiado)', () => {
    const raw = 'TYPE: feat\nREASON: agrega OTP\nMESSAGE:\nfeat(otp): agregar validación\n\n- detalle';
    expect(parse(raw)).toMatchObject({ type: 'feat', message: 'feat(otp): agregar validación\n\n- detalle' });
    expect(partialMessage('TYPE: feat\nREASON: x\nMESSAGE:\nfeat(otp): agre')).toBe('feat(otp): agre');
  });
});
