// Operaciones a medias con git real: continuar un merge resuelto, abortar y saltar en un rebase.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { hasConflictMarkers } from '../src/git/operations';

const dirs: string[] = [];

/** Repo con `base` y dos ramas que cambian la misma línea de app.txt. */
function conflictRepo(): GitService {
  const root = mkdtempSync(path.join(tmpdir(), 'multigit-op-'));
  dirs.push(root);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root });
  g('init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'app.txt'), 'base\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(root, 'app.txt'), 'feature\n');
  g('commit', '-q', '-am', 'feature');
  g('checkout', '-q', 'main');
  writeFileSync(path.join(root, 'app.txt'), 'main\n');
  g('commit', '-q', '-am', 'main');
  return new GitService(root);
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('operaciones en curso (git real)', () => {
  it('merge con conflicto: detecta marcas; resuelto, add + continue termina el merge', async () => {
    const repo = conflictRepo();
    await expect(repo.merge('feature')).rejects.toThrow();
    expect(await repo.getOperationInProgress()).toBe('merge');
    const conflicted = await repo.getConflictedFiles();
    expect(await repo.filesWithConflictMarkers(conflicted)).toEqual(['app.txt']);

    writeFileSync(path.join(repo.root, 'app.txt'), 'main y feature\n');
    expect(await repo.filesWithConflictMarkers(conflicted)).toEqual([]);
    await repo.addPaths(conflicted);
    await repo.continueOperation('merge');
    expect(await repo.getOperationInProgress()).toBeNull();
    expect((await repo.logCommits(['-1', 'HEAD']))[0]!.subject).toContain("Merge branch 'feature'");
  });

  it('rebase con conflicto: abort vuelve al estado anterior', async () => {
    const repo = conflictRepo();
    const before = await repo.headSha();
    await expect(repo.rebase('feature')).rejects.toThrow();
    expect(await repo.getOperationInProgress()).toBe('rebase');
    await repo.abortOperation('rebase');
    expect(await repo.getOperationInProgress()).toBeNull();
    expect(await repo.headSha()).toBe(before);
  });

  it('rebase con conflicto: skip salta el commit en conflicto', async () => {
    const repo = conflictRepo();
    await expect(repo.rebase('feature')).rejects.toThrow();
    await repo.skipOperation('rebase');
    expect(await repo.getOperationInProgress()).toBeNull();
    expect((await repo.logCommits(['-1', 'HEAD']))[0]!.subject).toBe('feature');
  });

  it('hasConflictMarkers', () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n')).toBe(true);
    expect(hasConflictMarkers('const x = "<<<<<<<";\n')).toBe(false);
  });
});
