// Acciones del Git Log que reescriben la rama (Undo Commit, Edit Commit Message, Drop, Fixup/Squash
// Into con autosquash, Push All up to Here) y pull/update con merge o rebase, con git real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { autosquashMessage, editPlan, historyBlocker, parseAutosquash, type HistoryInfo } from '../src/git/historyEdit';

const base: HistoryInfo = { branch: 'main', inBranch: true, isHead: false, isMerge: false, isRoot: false, mergesAfter: 0 };

describe('historyBlocker', () => {
  it('rama, commit en la rama, merges', () => {
    expect(historyBlocker('undo', { ...base, branch: null })).toBe('detached');
    expect(historyBlocker('drop', { ...base, inBranch: false })).toBe('not-in-branch');
    expect(historyBlocker('reword', { ...base, isMerge: true })).toBe('merge');
    expect(historyBlocker('drop', { ...base, isRoot: true })).toBe('root');
    expect(historyBlocker('undo', { ...base, isRoot: true })).toBe('root');
    expect(historyBlocker('drop', { ...base, mergesAfter: 1 })).toBe('merges-after');
    expect(historyBlocker('fixup', { ...base, mergesAfter: 2 })).toBe('merges-after');
  });

  it('casos permitidos', () => {
    // Undo es un reset: da igual que haya merges después.
    expect(historyBlocker('undo', { ...base, mergesAfter: 3 })).toBeUndefined();
    // Cambiar el mensaje de HEAD es un amend.
    expect(historyBlocker('reword', { ...base, isHead: true, mergesAfter: 0 })).toBeUndefined();
    expect(historyBlocker('reword', { ...base, isRoot: true })).toBeUndefined();
    // Push up to here sirve también con merges.
    expect(historyBlocker('pushUpTo', { ...base, isMerge: true, mergesAfter: 2 })).toBeUndefined();
    expect(historyBlocker('pushUpTo', { ...base, inBranch: false })).toBe('not-in-branch');
  });

  it('editPlan y autosquash', () => {
    const commits = ['a', 'b', 'c'].map((hash) => ({ hash, short: hash, subject: hash, message: hash, author: 'x', time: 0 }));
    expect(editPlan(commits, 'b', { action: 'drop' }).map((e) => e.action)).toEqual(['pick', 'drop', 'pick']);
    expect(editPlan(commits, 'a', { action: 'reword', message: 'nuevo' })[0]).toEqual({ hash: 'a', action: 'reword', message: 'nuevo' });
    expect(autosquashMessage('fixup', 'feat: uno')).toBe('fixup! feat: uno');
    expect(parseAutosquash('squash! feat: uno\n\ncuerpo')).toEqual({ kind: 'squash', subject: 'feat: uno' });
    expect(parseAutosquash('feat: uno')).toBeUndefined();
  });
});

describe('git real', () => {
  let tmp: string;
  let root: string;
  let remote: string;
  let git: GitService;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const subjects = () => run('log', '--format=%s').split('\n');
  const commit = (name: string, content = name) => {
    writeFileSync(path.join(root, `${name}.txt`), content);
    run('add', '.');
    run('commit', '-q', '-m', `feat: ${name}`);
    return run('rev-parse', 'HEAD');
  };

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'multigit-history-'));
    remote = path.join(tmp, 'remote.git');
    root = path.join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    run('remote', 'add', 'origin', remote);
    git = new GitService(root);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('Undo Commit: la rama vuelve al padre y los cambios quedan en el stage', async () => {
    commit('base');
    const uno = commit('uno');
    await git.undoCommit(uno);
    expect(subjects()).toEqual(['feat: base']);
    expect(run('status', '--porcelain')).toBe('A  uno.txt');
  });

  it('historyInfo: HEAD, merges posteriores y si ya está subido', async () => {
    commit('base');
    const uno = commit('uno');
    run('push', '-q', '-u', 'origin', 'main');
    const dos = commit('dos');
    const a = await git.historyInfo(uno);
    expect(a).toMatchObject({ branch: 'main', inBranch: true, isHead: false, isMerge: false, mergesAfter: 0, pushed: true, upstream: 'origin/main' });
    const b = await git.historyInfo(dos);
    expect(b).toMatchObject({ isHead: true, pushed: false });
    run('checkout', '-q', '-b', 'otra', uno);
    const otra = commit('otra');
    run('checkout', '-q', 'main');
    expect((await git.historyInfo(otra)).inBranch).toBe(false);
  });

  it('Edit Commit Message de HEAD: amend solo del mensaje (lo del stage no entra)', async () => {
    commit('base');
    commit('uno');
    writeFileSync(path.join(root, 'staged.txt'), 'x');
    run('add', 'staged.txt');
    await git.amendMessage('feat: uno corregido\n\ncon cuerpo');
    expect(run('log', '-1', '--format=%B')).toBe('feat: uno corregido\n\ncon cuerpo');
    expect(run('show', '--name-only', '--format=', 'HEAD')).toBe('uno.txt');
    expect(run('status', '--porcelain')).toBe('A  staged.txt');
  });

  it('Edit Commit Message de uno anterior y Drop, con cambios sin commit (autostash)', async () => {
    commit('base');
    const uno = commit('uno');
    const dos = commit('dos');
    commit('tres');
    writeFileSync(path.join(root, 'base.txt'), 'cambio local');

    let { base: b, commits } = await git.rebaseCommits(uno);
    await git.interactiveRebase(b, editPlan(commits, uno, { action: 'reword', message: 'feat: uno (editado)' }), { autostash: true });
    expect(subjects()).toEqual(['feat: tres', 'feat: dos', 'feat: uno (editado)', 'feat: base']);
    expect(readFileSync(path.join(root, 'base.txt'), 'utf8')).toBe('cambio local');

    const dosNow = run('log', '--format=%H', '--grep=^feat: dos$');
    expect(dosNow).not.toBe(dos);
    ({ base: b, commits } = await git.rebaseCommits(dosNow));
    await git.interactiveRebase(b, editPlan(commits, dosNow, { action: 'drop' }), { autostash: true });
    expect(subjects()).toEqual(['feat: tres', 'feat: uno (editado)', 'feat: base']);
    expect(run('ls-files')).not.toContain('dos.txt');
    expect(readFileSync(path.join(root, 'base.txt'), 'utf8')).toBe('cambio local');
  });

  it('Fixup: el commit "fixup!" se integra en el suyo con autosquash', async () => {
    commit('base');
    const uno = commit('uno');
    commit('dos');
    writeFileSync(path.join(root, 'uno.txt'), 'uno arreglado');
    run('commit', '-q', '-am', autosquashMessage('fixup', 'feat: uno'));
    writeFileSync(path.join(root, 'otro.txt'), 'sin commit');
    await git.autosquash(`${uno}^`);
    expect(subjects()).toEqual(['feat: dos', 'feat: uno', 'feat: base']);
    expect(run('show', 'HEAD~1:uno.txt')).toBe('uno arreglado');
    expect(readFileSync(path.join(root, 'otro.txt'), 'utf8')).toBe('sin commit');
  });

  it('Squash Into: los mensajes se combinan', async () => {
    commit('base');
    const uno = commit('uno');
    writeFileSync(path.join(root, 'uno.txt'), 'más');
    run('commit', '-q', '-am', `${autosquashMessage('squash', 'feat: uno')}\n\ndetalle extra`);
    await git.autosquash(`${uno}^`);
    expect(subjects()).toEqual(['feat: uno', 'feat: base']);
    expect(run('log', '-1', '--format=%B')).toContain('detalle extra');
  });

  it('Push All up to Here: sube hasta el commit, no los posteriores', async () => {
    commit('base');
    run('push', '-q', '-u', 'origin', 'main');
    const uno = commit('uno');
    commit('dos');
    await git.pushRevision('origin', uno, 'main');
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe(uno);
    run('fetch', '-q');
    expect((await git.getStatus()).ahead).toBe(1);
  });

  it('Pull into Current Using Rebase de otra rama remota', async () => {
    commit('base');
    run('push', '-q', '-u', 'origin', 'main');
    // Otro clon sube una rama "develop" con un commit.
    const other = path.join(tmp, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    writeFileSync(path.join(other, 'remoto.txt'), 'r');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', ['commit', '-q', '-m', 'feat: remoto'], { cwd: other });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:develop'], { cwd: other });
    commit('local');
    await git.fetchAll();
    await git.pullWith('rebase', 'origin', 'develop');
    expect(subjects()).toEqual(['feat: local', 'feat: remoto', 'feat: base']);
  });
});
