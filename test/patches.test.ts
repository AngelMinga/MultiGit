// Patches: partir, reescribir rutas, combinar varios repos y repartirlos al aplicar (con git real).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { assignPatch, combinePatches, joinPatch, parsePatch, patchFileName, patchPath, remapFile } from '../src/git/patches';
import { commitOptionArgs, isValidAuthor, uniqueAuthors } from '../src/git/commitMessage';

const MODIFY = `diff --git a/src/a b.ts b/src/a b.ts
index 1111111..2222222 100644
--- a/src/a b.ts
+++ b/src/a b.ts
@@ -1 +1 @@
-uno
+dos
`;
const RENAME = `diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-x
+y
`;
const NEW = `diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/n.txt
@@ -0,0 +1 @@
+hola
`;
const MODE = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

describe('parsePatch / remapFile', () => {
  it('rutas de modificado (con espacios), renombrado, nuevo y cambio de modo', () => {
    const files = parsePatch(`From abc Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n---\n${MODIFY}${RENAME}${NEW}${MODE}-- \n2.43.0\n\n`);
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([
      ['src/a b.ts', 'src/a b.ts'],
      ['old.txt', 'new.txt'],
      [null, 'n.txt'],
      ['run.sh', 'run.sh'],
    ]);
    expect(files[3]!.text).toBe(MODE);
    expect(files.map(patchPath)).toEqual(['src/a b.ts', 'new.txt', 'n.txt', 'run.sh']);
  });

  it('remapFile cambia diff --git, ---/+++ y rename from/to; deja /dev/null y los hunks', () => {
    const [rename] = parsePatch(RENAME);
    const out = remapFile(rename!, (p) => `mftheme/${p}`).text;
    expect(out).toContain('diff --git a/mftheme/old.txt b/mftheme/new.txt');
    expect(out).toContain('rename from mftheme/old.txt\nrename to mftheme/new.txt');
    expect(out).toContain('--- a/mftheme/old.txt\n+++ b/mftheme/new.txt\n@@ -1 +1 @@\n-x\n+y\n');
    const [created] = parsePatch(NEW);
    expect(remapFile(created!, (p) => `shell/${p}`).text).toContain('--- /dev/null\n+++ b/shell/n.txt');
  });

  it('combinar y repartir por repo (el prefijo más largo gana); sin prefijo → unmatched', () => {
    const combined = combinePatches([
      { dir: 'mftheme', patch: MODIFY },
      { dir: 'apps/shell', patch: NEW + RENAME },
    ]);
    const files = parsePatch(combined);
    expect(files.map(patchPath)).toEqual(['mftheme/src/a b.ts', 'apps/shell/n.txt', 'apps/shell/new.txt']);
    const { byRepo, unmatched } = assignPatch([...files, ...parsePatch(MODE)], [
      { repo: 'theme', dir: 'mftheme' },
      { repo: 'apps', dir: 'apps' },
      { repo: 'shell', dir: 'apps/shell' },
    ]);
    expect(joinPatch(byRepo.get('theme')!)).toBe(MODIFY);
    expect(joinPatch(byRepo.get('shell')!)).toBe(NEW + RENAME);
    expect(byRepo.has('apps')).toBe(false);
    expect(unmatched.map(patchPath)).toEqual(['run.sh']);
  });

  it('patchFileName', () => {
    expect(patchFileName('feature/ABC-12 añadir botón')).toBe('feature-ABC-12-anadir-boton.patch');
    expect(patchFileName('///')).toBe('changes.patch');
  });
});

describe('opciones del commit', () => {
  it('autor, sign-off y hooks', () => {
    expect(isValidAuthor('Ana Pérez <ana@empresa.com>')).toBe(true);
    expect(isValidAuthor('Ana <ana>')).toBe(false);
    expect(isValidAuthor('ana@empresa.com')).toBe(false);
    expect(commitOptionArgs({ author: ' Ana <a@b.c> ', signoff: true, noVerify: true })).toEqual(['--author=Ana <a@b.c>', '--signoff', '--no-verify']);
    expect(commitOptionArgs({})).toEqual([]);
    expect(uniqueAuthors(['A <a@x.y>', 'B <b@x.y>', 'A <a@x.y>', 'basura'])).toEqual(['A <a@x.y>', 'B <b@x.y>']);
  });
});

describe('git real', () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const init = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    writeFileSync(path.join(dir, 'a.txt'), 'uno\ndos\ntres\n');
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
  };

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    tmp = mkdtempSync(path.join(tmpdir(), 'multigit-patch-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('patch de dos repos (con archivo nuevo y renombrado) aplicado en otros dos clones', async () => {
    const src = { theme: path.join(tmp, 'src/mftheme'), shell: path.join(tmp, 'src/shell') };
    init(src.theme);
    init(src.shell);
    const dst = { theme: path.join(tmp, 'dst/mftheme'), shell: path.join(tmp, 'dst/shell') };
    execFileSync('git', ['clone', '-q', src.theme, dst.theme]);
    execFileSync('git', ['clone', '-q', src.shell, dst.shell]);

    writeFileSync(path.join(src.theme, 'a.txt'), 'uno\nDOS\ntres\n');
    writeFileSync(path.join(src.theme, 'nuevo archivo.txt'), 'nuevo\n');
    git(src.shell, 'mv', 'b.txt', 'c.txt');
    const theme = new GitService(src.theme);
    const shell = new GitService(src.shell);
    const combined = combinePatches([
      { dir: 'mftheme', patch: (await theme.patchTracked(['a.txt'])) + (await theme.patchUntracked('nuevo archivo.txt')) },
      { dir: 'shell', patch: await shell.patchTracked(['b.txt', 'c.txt']) },
    ]);

    const targets = [
      { repo: new GitService(dst.theme), dir: 'mftheme' },
      { repo: new GitService(dst.shell), dir: 'shell' },
    ];
    const { byRepo, unmatched } = assignPatch(parsePatch(combined), targets);
    expect(unmatched).toEqual([]);
    for (const [repo, files] of byRepo) {
      await repo.applyPatch(joinPatch(files), 'check');
      await repo.applyPatch(joinPatch(files), 'apply');
    }
    expect(readFileSync(path.join(dst.theme, 'a.txt'), 'utf8')).toBe('uno\nDOS\ntres\n');
    expect(readFileSync(path.join(dst.theme, 'nuevo archivo.txt'), 'utf8')).toBe('nuevo\n');
    expect(readFileSync(path.join(dst.shell, 'c.txt'), 'utf8')).toBe('b\n');
    expect(git(dst.shell, 'status', '--porcelain')).toContain('b.txt');
  });

  it('patch de un commit (format-patch) y --3way cuando no encaja', async () => {
    const repo = path.join(tmp, 'tres');
    init(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'uno\nDOS\ntres\n');
    git(repo, 'commit', '-q', '-am', 'feat: dos en mayúsculas');
    const service = new GitService(repo);
    const patch = await service.commitPatch('HEAD');
    expect(patch).toContain('Subject: [PATCH]');
    expect(parsePatch(patch).map(patchPath)).toEqual(['a.txt']);
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    // Cambio local que choca con el patch.
    writeFileSync(path.join(repo, 'a.txt'), 'uno\ndos local\ntres\n');
    git(repo, 'commit', '-q', '-am', 'local');
    await expect(service.applyPatch(patch, 'check')).rejects.toThrow();
    await expect(service.applyPatch(patch, 'threeWay')).rejects.toThrow();
    expect(await service.getConflictedFiles()).toEqual(['a.txt']);
  });

  it('commit con autor, sign-off y sin hooks', async () => {
    const repo = path.join(tmp, 'opts');
    init(repo);
    mkdirSync(path.join(repo, '.git/hooks'), { recursive: true });
    writeFileSync(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(path.join(repo, 'a.txt'), 'cambio\n');
    const service = new GitService(repo);
    await expect(service.commitPaths('feat: x', ['a.txt'], false)).rejects.toThrow();
    await service.commitPaths('feat: x', ['a.txt'], false, { author: 'Ana Pérez <ana@empresa.com>', signoff: true, noVerify: true });
    expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Ana Pérez <ana@empresa.com>');
    expect(git(repo, 'log', '-1', '--format=%B')).toBe('feat: x\n\nSigned-off-by: Test <test@example.com>');
    expect(await service.recentAuthors()).toEqual(['Ana Pérez <ana@empresa.com>', 'Test <test@example.com>']);
  });
});
