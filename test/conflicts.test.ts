// Diálogo de conflictos: estados de cada lado, nombres de las columnas y "Accept" con git real.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchFromMergeMessage, countConflictBlocks, sidesOf } from '../src/git/conflicts';
import { GitService } from '../src/git/GitService';

describe('puro', () => {
  it('sidesOf', () => {
    expect(sidesOf('U', 'U')).toEqual({ yours: 'modified', theirs: 'modified' });
    expect(sidesOf('D', 'U')).toEqual({ yours: 'deleted', theirs: 'modified' });
    expect(sidesOf('A', 'A')).toEqual({ yours: 'added', theirs: 'added' });
  });
  it('countConflictBlocks y branchFromMergeMessage', () => {
    expect(countConflictBlocks('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n<<<<<<< HEAD\n')).toBe(2);
    expect(branchFromMergeMessage("Merge branch 'des_otp' of https://git/x into dev")).toBe('des_otp');
    expect(branchFromMergeMessage("Merge remote-tracking branch 'origin/des_otp'\n\n# Conflicts:")).toBe('origin/des_otp');
    expect(branchFromMergeMessage('feat: x')).toBeUndefined();
  });
});

describe('git real', () => {
  let root: string;
  let git: GitService;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const tryRun = (...args: string[]) => {
    try {
      run(...args);
    } catch {
      // el merge/rebase con conflictos sale con error
    }
  };
  const write = (f: string, s: string) => writeFileSync(path.join(root, f), s);
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    root = mkdtempSync(path.join(tmpdir(), 'multigit-conflicts-'));
    execFileSync('git', ['init', '-q', '-b', 'dev', root]);
    write('api.ts', 'base\n');
    write('borrar.ts', 'b\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    run('checkout', '-q', '-b', 'des_otp');
    write('api.ts', 'theirs\n');
    write('borrar.ts', 'b cambiado\n');
    run('commit', '-q', '-am', 'feat: otp');
    run('checkout', '-q', 'dev');
    write('api.ts', 'yours\n');
    run('rm', '-q', 'borrar.ts');
    run('commit', '-q', '-am', 'feat: dev');
    git = new GitService(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    tryRun('merge', '--abort');
    tryRun('rebase', '--abort');
    run('checkout', '-q', '-f', 'dev');
  });

  it('merge: columnas con las ramas y estados de cada lado', async () => {
    tryRun('merge', 'des_otp');
    expect(await git.conflictLabels()).toEqual({ operation: 'merge', current: 'dev', incoming: 'des_otp' });
    const files = (await git.getChanges()).filter((f) => f.kind === 'conflict');
    expect(files.map((f) => [f.path, sidesOf(f.index, f.worktree)])).toEqual([
      ['api.ts', { yours: 'modified', theirs: 'modified' }],
      ['borrar.ts', { yours: 'deleted', theirs: 'modified' }],
    ]);
    expect(countConflictBlocks(read('api.ts'))).toBe(1);
  });

  it('Accept Yours / Theirs, también cuando un lado borró el archivo', async () => {
    tryRun('merge', 'des_otp');
    await git.acceptConflictSide(['api.ts'], 'theirs');
    expect(read('api.ts')).toBe('theirs\n');
    await git.acceptConflictSide(['borrar.ts'], 'ours', ['borrar.ts']); // yours = borrado
    expect(existsSync(path.join(root, 'borrar.ts'))).toBe(false);
    expect(await git.getConflictedFiles()).toEqual([]);
    await git.continueOperation('merge');
    expect(run('log', '-1', '--format=%s').trim()).toBe("Merge branch 'des_otp' into dev");
  });

  it('rebase: Yours es la rama sobre la que se rebasea y Theirs tu commit', async () => {
    // Ramas propias desde el primer commit (dev ya integró des_otp en el test anterior).
    const init = run('rev-list', '--max-parents=0', 'HEAD').trim();
    run('checkout', '-q', '-b', 'base-r', init);
    write('api.ts', 'base-r\n');
    run('commit', '-q', '-am', 'feat: base-r');
    run('checkout', '-q', '-b', 'mia', init);
    write('api.ts', 'mia\n');
    run('commit', '-q', '-am', 'feat: mia');
    tryRun('rebase', 'base-r');
    const labels = await git.conflictLabels();
    expect(labels.operation).toBe('rebase');
    expect(labels.current).toBe('base-r');
    expect(labels.incoming).toMatch(/^mia: [0-9a-f]{7,} feat: mia$/);
  });
});
