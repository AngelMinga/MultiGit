// Tests dentro de VS Code: activación, comandos registrados y que todas las vistas se dibujan.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { MultiGitTestApi } from '../src/extension';
import { allLineIds, diffFingerprint, parseHunks } from '../src/git/hunks';
import { runCommitChecks } from '../src/views/commitChecks';
import { RebasePanel } from '../src/webview/RebasePanel';
import { MergePanel } from '../src/webview/MergePanel';
import { runInRepos } from '../src/git/MultiRepoRunner';
import { addList, moveTo, setActive } from '../src/git/changelists';
import { keyOf } from '../src/views/ChangesTree';

/** Recorre un TreeDataProvider completo y devuelve cada elemento con su TreeItem. */
async function walk<T>(provider: vscode.TreeDataProvider<T>, parent?: T, depth = 0): Promise<Array<{ node: T; item: vscode.TreeItem }>> {
  const children = (await provider.getChildren(parent)) ?? [];
  const out: Array<{ node: T; item: vscode.TreeItem }> = [];
  for (const node of children) {
    const item = await provider.getTreeItem(node);
    out.push({ node, item });
    if (depth < 8 && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      out.push(...(await walk(provider, node, depth + 1)));
    }
  }
  return out;
}

/**
 * Cierra la pestaña de un webview cuyo título cumple `re`. La busca otra vez justo antes de cerrarla y
 * reintenta: los diálogos se mueven a una ventana flotante y la pestaña encontrada antes deja de valer.
 */
async function closeWebviewTab(re: RegExp): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && re.test(x.label));
    if (!tab) return;
    try {
      await vscode.window.tabGroups.close(tab);
    } catch {
      // se movió a otra ventana mientras tanto: se vuelve a buscar
    }
  }
}

const label = (item: vscode.TreeItem) => (typeof item.label === 'string' ? item.label : item.label?.label ?? '');

// En GitHub Actions, cada test fallido se publica como anotación (se lee sin entrar a los logs).
afterEach(function () {
  const test = this.currentTest;
  if (process.env.GITHUB_ACTIONS && test?.state === 'failed') {
    const message = String(test.err?.message ?? 'falló').replace(/\r?\n/g, '%0A');
    console.log(`::error title=e2e: ${test.fullTitle()}::${message}`);
  }
});

describe('MultiGit en VS Code', () => {
  let api: MultiGitTestApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit');
    assert.ok(ext, 'la extensión está instalada en la instancia de prueba');
    api = await ext.activate();
    // initialize() ya terminó dentro de activate; por si la API de git abrió repos después:
    await api.manager.refresh();
    if (process.env.GITHUB_ACTIONS) {
      const repos = api.manager.all.map((r) => `${r.name}@${r.status?.branch ?? r.error ?? '?'}`).join(', ');
      console.log(`::notice title=e2e::workspace ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath} · repos: ${repos || 'ninguno'}`);
    }
  });

  it('detecta los 3 repos del workspace', () => {
    assert.deepEqual(
      api.manager.all.map((r) => r.name),
      ['mflogin', 'mftheme', 'shell'],
    );
    assert.equal(api.manager.all.find((r) => r.name === 'mflogin')?.status?.branch, 'develop');
  });

  it('cada comando de package.json está registrado', async () => {
    const declared = (vscode.extensions.getExtension('angelminga-multigit.multigit')!.packageJSON.contributes.commands as Array<{ command: string }>).map(
      (c) => c.command,
    );
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((c) => !registered.has(c));
    assert.deepEqual(missing, [], `comandos declarados sin registrar: ${missing.join(', ')}`);
  });

  it('Repositorios: todos los ítems se dibujan y el desalineado lleva ≠', async () => {
    const items = await walk(api.repositories);
    assert.equal(items.length, 3);
    const mflogin = items.find((i) => label(i.item) === 'mflogin')!;
    assert.match(String(mflogin.item.description), /^≠ ⎇ develop/);
    const mftheme = items.find((i) => label(i.item) === 'mftheme')!;
    assert.match(String(mftheme.item.description), /⎇ dev-x/);
    assert.ok(mftheme.item.tooltip, 'tooltip armado');
  });

  it('Ramas: el árbol completo se dibuja, con la rama actual marcada', async () => {
    const items = await walk(api.branches);
    const labels = items.map((i) => label(i.item));
    assert.ok(labels.includes('Local') && labels.includes('Remote'));
    const current = items.filter((i) => i.item.description === 'current').map((i) => label(i.item));
    assert.ok(current.includes('dev-x') && current.includes('develop'), `ramas actuales: ${current.join(', ')}`);
  });

  it('Changes: archivo modificado marcado y archivo nuevo en Unversioned Files', async () => {
    await api.changes.refresh();
    const items = await walk(api.changes);
    const labels = items.map((i) => label(i.item));
    assert.ok(labels.includes('Changes') && labels.includes('Unversioned Files'), labels.join(' | '));
    const modified = items.find((i) => label(i.item) === 'index.js')!;
    assert.equal(modified.item.checkboxState, vscode.TreeItemCheckboxState.Checked);
    const untracked = items.find((i) => label(i.item) === 'nuevo.js')!;
    assert.equal(untracked.item.checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  });

  it('Changes: todas las combinaciones de Group By se dibujan', async () => {
    const toggles = ['toggleGroupByRepo', 'toggleGroupByModule', 'toggleGroupByDir', 'toggleShowIgnored'];
    for (const t of toggles) {
      await vscode.commands.executeCommand(`multigit.changes.${t}`);
      await api.changes.refresh();
      const items = await walk(api.changes);
      assert.ok(items.some((i) => label(i.item) === 'index.js'), `con ${t}`);
    }
    // Volver al estado inicial.
    for (const t of toggles) await vscode.commands.executeCommand(`multigit.changes.${t}`);
  });

  it('Stashes: el stash de shell y mflogin se ve como uno, con sus archivos', async () => {
    api.stashes.refresh();
    const items = await walk(api.stashes);
    const group = items.find((i) => label(i.item) === 'WIP e2e');
    assert.ok(group, `stashes: ${items.map((i) => label(i.item)).join(', ')}`);
    assert.match(String(group.item.description), /^2 /);
    const repos = items.filter((i) => i.item.contextValue === 'multigit.stash.entry').map((i) => label(i.item));
    assert.deepEqual(repos, ['mflogin', 'shell']);
    const files = items.filter((i) => i.item.contextValue === 'multigit.stash.file');
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => label(f.item) === 'package.json' && f.item.command?.command === 'multigit.stashes.openDiff'));
    await vscode.commands.executeCommand('multigit.stashes.openDiff', files[0]!.node);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff, 'se abre un diff');
    assert.equal(tab.modified.scheme, 'multigit-git');
    assert.equal((await vscode.workspace.openTextDocument(tab.modified)).getText(), '{ "name": "mflogin", "wip": true }\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('comandos sin diálogos se ejecutan sin error', async () => {
    await vscode.commands.executeCommand('multigit.stashes.refresh');
    await vscode.commands.executeCommand('multigit.refresh');
    await vscode.commands.executeCommand('multigit.changes.refresh');
    await vscode.commands.executeCommand('multigit.branchesTree.refresh');
    await vscode.commands.executeCommand('multigit.openGitLog');
    await vscode.commands.executeCommand('multigit.showLog');
  });
});

describe('Commit parcial', () => {
  let api: MultiGitTestApi;
  before(async () => {
    api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
  });

  it('elige el primer hunk de un archivo y solo ese entra en el commit', async () => {
    const repo = api.manager.all.find((r) => r.name === 'mflogin')!;
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, env, encoding: 'utf8' });
    const file = path.join(repo.root, 'src', 'app.js');
    writeFileSync(file, 'a\nb\nc\nd\ne\nf\ng\nh\n');
    git('add', 'src/app.js');
    git('commit', '-q', '-m', 'feat: app');
    writeFileSync(file, 'a\nB\nc\nd\ne\nf\ng\nH\n');
    await api.manager.refresh();
    await api.changes.refresh();

    const node = (await walk(api.changes)).find((i) => label(i.item) === 'app.js')!;
    assert.equal(node.item.contextValue, 'multigit.changes.file.tracked');
    // El diálogo se abre sin errores (las casillas se eligen en el webview; aquí se guarda la selección a mano).
    await vscode.commands.executeCommand('multigit.changes.selectHunks', node.node);
    // La pestaña del webview aparece un poco después.
    let tabs: readonly vscode.Tab[] = [];
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !tab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      tab = tabs.find((x) => x.input instanceof vscode.TabInputWebview && /app\.js/.test(x.label));
    }
    assert.ok(tab, `pestañas: ${tabs.map((x) => x.label).join(', ')}`);
    await closeWebviewTab(/app\.js/);

    const diff = await repo.git.diffForPartial('src/app.js');
    const hunks = parseHunks(diff)!;
    assert.ok(node.node.kind === 'file');
    const ref = { repo, file: node.node.ref.file };
    api.changes.setOnlyChecked([ref]);
    api.changes.setPartial(ref, { fingerprint: diffFingerprint(diff), selected: hunks[0]!.lines.map((l) => l.id), total: allLineIds(hunks).length });
    const after = (await walk(api.changes)).find((i) => label(i.item) === 'app.js')!;
    assert.match(String(after.item.description), /^2\/4 /);

    const done = await api.changesActions.commit('feat: solo B', false);
    assert.deepEqual(done?.map((r) => r.name), ['mflogin']);
    assert.equal(git('show', 'HEAD:src/app.js'), 'a\nB\nc\nd\ne\nf\ng\nh\n');
    assert.equal(readFileSync(file, 'utf8'), 'a\nB\nc\nd\ne\nf\ng\nH\n');
    assert.equal(git('status', '--porcelain', '--', 'src/app.js'), ' M src/app.js\n');
    assert.equal(api.changes.partialOf(ref), undefined);
  });
});

describe('Checkout en todos los repos', () => {
  it('una rama local común: el checkout cambia todos los repos y conserva los cambios sin commit', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const repos = api.manager.all;
    assert.ok(repos.length > 1);
    const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const original = new Map(repos.map((r) => [r, git(r.root, 'branch', '--show-current')]));
    for (const r of repos) git(r.root, 'branch', 'e2e-comun');
    // Un cambio sin commit en un repo (como mftheme en el workspace real): git lo lleva a la otra rama.
    const dirty = repos[0]!;
    const file = path.join(dirty.root, 'e2e-checkout.txt');
    writeFileSync(file, 'base\n');
    git(dirty.root, 'add', 'e2e-checkout.txt');
    execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'e2e checkout'], { cwd: dirty.root });
    git(dirty.root, 'branch', '-f', 'e2e-comun');
    writeFileSync(file, 'cambio sin commit\n');
    const config = vscode.workspace.getConfiguration('multigit');
    await config.update('confirmCheckoutWithChanges', false, vscode.ConfigurationTarget.Global);
    try {
      await api.manager.refresh();
      await api.branchActions.checkout({ repos, label: 'all' }, { type: 'local', name: 'e2e-comun' });
      for (const r of repos) assert.equal(git(r.root, 'branch', '--show-current'), 'e2e-comun', r.name);
      assert.equal(readFileSync(file, 'utf8'), 'cambio sin commit\n');
    } finally {
      await config.update('confirmCheckoutWithChanges', undefined, vscode.ConfigurationTarget.Global);
      git(dirty.root, 'checkout', '-q', '--', 'e2e-checkout.txt');
      for (const [r, branch] of original) {
        git(r.root, 'checkout', '-q', branch);
        git(r.root, 'branch', '-D', 'e2e-comun');
      }
      git(dirty.root, 'reset', '-q', '--hard', 'HEAD~1');
      await api.manager.refresh();
    }
  });
});

describe('Changelists', () => {
  let api: MultiGitTestApi;
  before(async () => {
    api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
  });

  it('una lista nueva, mover un archivo, solo la activa entra marcada y commit con autor y sign-off', async () => {
    const repo = api.manager.all.find((r) => r.name === 'mflogin')!;
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, env, encoding: 'utf8' });
    for (const f of ['uno.txt', 'dos.txt']) writeFileSync(path.join(repo.root, f), 'base\n');
    git('add', 'uno.txt', 'dos.txt');
    git('commit', '-q', '-m', 'chore: base changelists');
    for (const f of ['uno.txt', 'dos.txt']) writeFileSync(path.join(repo.root, f), 'cambio\n');
    await api.manager.refresh();
    await api.changes.refresh();
    const before = api.changes.changelists;
    try {
      const refOf = (name: string) => api.changes.trackedFiles.find((r) => r.repo === repo && r.file.path === name)!;
      // Nueva lista activa "Tarea"; "dos.txt" pasa a ella.
      api.changes.updateLists(moveTo(setActive(addList(before, 'e2e', 'Tarea'), 'e2e'), [keyOf(refOf('dos.txt'))], 'e2e'), [refOf('uno.txt'), refOf('dos.txt')]);
      const items = await walk(api.changes);
      const sections = items.filter((i) => i.node.kind === 'section' && i.node.section === 'changes');
      assert.deepEqual(sections.map((i) => label(i.item)), ['Changes', 'Tarea']);
      assert.equal(sections[1]!.item.contextValue, 'multigit.changes.section.changes.active');
      assert.equal(sections[0]!.item.contextValue, 'multigit.changes.section.changes.default');
      assert.ok(api.changes.isChecked(refOf('dos.txt')), 'dos.txt (lista activa) marcado');
      assert.ok(!api.changes.isChecked(refOf('uno.txt')), 'uno.txt (otra lista) sin marcar');
      // Los dos repos pueden tener el mismo repo en dos listas: ids distintos.
      const ids = items.map((i) => i.item.id);
      assert.equal(new Set(ids).size, ids.length);

      api.changes.setOnlyChecked([refOf('dos.txt')]);
      const done = await api.changesActions.commit('feat: dos', false, { author: 'Ana Pérez <ana@empresa.com>', signoff: true });
      assert.deepEqual(done?.map((r) => r.name), ['mflogin']);
      assert.equal(git('log', '-1', '--format=%an <%ae>').trim(), 'Ana Pérez <ana@empresa.com>');
      assert.match(git('log', '-1', '--format=%B'), /\n\nSigned-off-by: [^<]+ <[^>]+>/);
      assert.equal(api.changes.filesInList('e2e').length, 0);
      assert.equal(api.changes.listOfRef(refOf('uno.txt')), 'default');
    } finally {
      api.changes.updateLists(before);
      git('checkout', '--', 'uno.txt');
      await api.changes.refresh();
    }
  });
});

describe('Comprobaciones antes del commit', () => {
  it('encuentra TODO, marcas de conflicto y secretos en un archivo nuevo', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const repo = api.manager.all.find((r) => r.name === 'shell')!;
    writeFileSync(path.join(repo.root, 'checks.js'), '// TODO: revisar\n<<<<<<< HEAD\nconst k = "AKIAABCDEFGHIJKLMNOP";\n');
    const file = { path: 'checks.js', index: '?', worktree: '?', kind: 'untracked', status: '?' } as const;
    const findings = await runCommitChecks([{ repo, files: [{ file: file as never }] }]);
    assert.deepEqual(
      findings.map((f) => `${f.kind}:${f.line}`),
      ['conflict:2', 'secret:3', 'todo:1'],
    );
  });
});

describe('Grupos de repos', () => {
  it('con un grupo activo, MultiGit trabaja solo con sus repos', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    await vscode.workspace.getConfiguration('multigit').update('repoGroups', { front: ['mf*'] }, vscode.ConfigurationTarget.Workspace);
    try {
      await api.manager.setActiveGroup('front');
      assert.deepEqual(api.manager.all.map((r) => r.name), ['mflogin', 'mftheme']);
      assert.equal(api.manager.allRepos.length, 3);
      const repos = await walk(api.repositories);
      assert.deepEqual(repos.map((i) => label(i.item)).filter((l) => ['mflogin', 'mftheme', 'shell'].includes(l)), ['mflogin', 'mftheme']);
    } finally {
      await api.manager.setActiveGroup(undefined);
      await vscode.workspace.getConfiguration('multigit').update('repoGroups', undefined, vscode.ConfigurationTarget.Workspace);
    }
    assert.equal(api.manager.all.length, 3);
  });
});

describe('Comparar ramas por archivos', () => {
  it('lista los archivos distintos por repo y abre su diff', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const repo = api.manager.all.find((r) => r.name === 'shell')!;
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    writeFileSync(path.join(repo.root, 'cmp.js'), 'export const cmp = 1;\n');
    execFileSync('git', ['add', 'cmp.js'], { cwd: repo.root, env });
    execFileSync('git', ['commit', '-q', '-m', 'feat: cmp'], { cwd: repo.root, env });
    await api.manager.refresh();

    await vscode.commands.executeCommand('multigit.compareFiles.show', api.manager.all, 'develop');
    const items = await walk(api.compareFiles);
    const shell = items.find((i) => label(i.item) === 'shell');
    assert.ok(shell, items.map((i) => label(i.item)).join(', '));
    const files = items.filter((i) => i.item.contextValue === 'multigit.compare.file');
    assert.deepEqual(files.map((f) => `${label(f.item)} ${String(f.item.description)}`), ['cmp.js A']);
    assert.ok(items.some((i) => /mflogin/.test(label(i.item)) && /mftheme/.test(label(i.item))), 'sin diferencias: mflogin y mftheme');

    await vscode.commands.executeCommand('multigit.compareFiles.openDiff', files[0]!.node);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff);
    assert.equal((await vscode.workspace.openTextDocument(tab.modified)).getText(), 'export const cmp = 1;\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('multigit.compareFiles.close');
    assert.equal((await walk(api.compareFiles)).length, 0);
  });
});

describe('Rebase interactivo', () => {
  it('abre el diálogo desde un commit de la rama actual y rechaza uno que no está en ella', async () => {
    const ext = vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!;
    const api = await ext.activate();
    const repo = api.manager.all.find((r) => r.name === 'shell')!;
    const first = (await repo.git.exec(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    await RebasePanel.open(ext.extensionUri, api.manager, repo, first, async () => undefined);
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !tab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /shell/.test(x.label));
    }
    assert.ok(tab, 'pestaña del rebase');
    await closeWebviewTab(/shell/);
    const { commits, base } = await repo.git.rebaseCommits(first);
    assert.equal(base, null);
    assert.deepEqual(commits.map((c) => c.subject), ['feat: shell inicial', 'feat: cmp']);
  });
});

describe('Pull', () => {
  it('Pull… abre el diálogo de una línea (repositorio · remote · rama) en una ventana flotante', async () => {
    const groupsBefore = new Set(vscode.window.tabGroups.all);
    await vscode.commands.executeCommand('multigit.pull');
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !tab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /^Pull/.test(x.label));
    }
    assert.ok(tab, 'pestaña de Pull');
    // Ventana propia: la pestaña acaba en un grupo nuevo (el de la ventana flotante).
    const pullTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /^Pull/.test(x.label));
    for (let i = 0; i < 40 && groupsBefore.has(pullTab()!.group); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!groupsBefore.has(pullTab()!.group), 'el diálogo se movió a una ventana propia');
    await closeWebviewTab(/^Pull/);
  });
});

describe('Conflictos', () => {
  it('un merge con conflicto abre el diálogo Conflicts y Accept lo resuelve', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const repo = api.manager.all.find((r) => r.name === 'mftheme')!;
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, env, encoding: 'utf8' });
    git('stash', 'push', '-q', '-u');
    git('checkout', '-q', '-b', 'conf-a');
    writeFileSync(path.join(repo.root, 'conf.js'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'a');
    git('checkout', '-q', 'dev-x');
    writeFileSync(path.join(repo.root, 'conf.js'), 'b\n');
    git('add', '.');
    git('commit', '-q', '-m', 'b');
    try {
      git('merge', 'conf-a');
    } catch {
      // conflicto esperado
    }
    await api.manager.refresh();
    await vscode.commands.executeCommand('multigit.resolveConflicts');
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !tab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /Conflict/.test(x.label));
    }
    assert.ok(tab, 'pestaña Conflicts');
    // La ventana de merge propia se abre para ese archivo.
    const ext = vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!;
    assert.equal(await MergePanel.open(ext.extensionUri, api.manager, repo, 'conf.js'), true);
    let mergeTab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !mergeTab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      mergeTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /conf\.js/.test(x.label));
    }
    assert.ok(mergeTab, 'pestaña de la ventana de merge');
    await closeWebviewTab(/conf\.js/);
    // Lo mismo que hace "Accept" en Theirs:
    await repo.git.acceptConflictSide(['conf.js'], 'theirs');
    assert.equal(readFileSync(path.join(repo.root, 'conf.js'), 'utf8'), 'a\n');
    assert.deepEqual(await repo.git.getConflictedFiles(), []);
    await closeWebviewTab(/Conflict/);
    git('commit', '-q', '--no-edit');
    git('stash', 'pop', '-q');
    await api.manager.refresh();
  });
});

describe('Merge en varios repos', () => {
  it('si un repo queda con conflictos, sigue con los demás', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    const repos = api.manager.all.filter((r) => r.name === 'mflogin' || r.name === 'shell');
    for (const repo of repos) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, env, encoding: 'utf8' });
      git('stash', 'push', '-q', '-u');
      const current = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      git('checkout', '-q', '-b', 'multi-a');
      writeFileSync(path.join(repo.root, 'multi.js'), 'a\n');
      git('add', '.');
      git('commit', '-q', '-m', 'a');
      git('checkout', '-q', current);
      writeFileSync(path.join(repo.root, 'multi.js'), 'b\n');
      git('add', '.');
      git('commit', '-q', '-m', 'b');
    }
    await api.manager.refresh();
    const results = await runInRepos(api.manager, {
      title: 'Merge multi-a',
      repos,
      silent: true,
      continueAfterConflict: true,
      run: async (repo) => {
        await repo.git.merge('multi-a');
      },
    });
    // Los dos repos se intentaron (antes se paraba en el primero) y los dos quedan con su conflicto.
    assert.deepEqual(
      results?.map((r) => [r.repo, r.state, r.conflicts]),
      repos.map((r) => [r.name, 'failed', ['multi.js']]),
    );
    for (const repo of repos) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, env, encoding: 'utf8' });
      git('merge', '--abort');
      git('stash', 'pop', '-q');
    }
    await api.manager.refresh();
  });
});

describe('Administrar remotos', () => {
  it('abre la ventana Git Remotes', async () => {
    await vscode.commands.executeCommand('multigit.manageRemotes');
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 40 && !tab; i++) {
      await new Promise((r) => setTimeout(r, 50));
      tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputWebview && /Remot/.test(x.label));
    }
    assert.ok(tab, 'pestaña de remotos');
    await closeWebviewTab(/Remot/);
  });
});

describe('package.json', () => {
  it('ningún submenú aparece dos veces en el mismo menú (VS Code descarta el segundo)', () => {
    const menus = vscode.extensions.getExtension('angelminga-multigit.multigit')!.packageJSON.contributes.menus as Record<
      string,
      Array<{ submenu?: string }>
    >;
    const repeated = Object.entries(menus).flatMap(([menu, items]) => {
      const subs = items.map((i) => i.submenu).filter(Boolean);
      return subs.filter((s, i) => subs.indexOf(s) !== i).map((s) => `${menu}: ${s}`);
    });
    assert.deepEqual(repeated, []);
  });
});

describe('Annotate with Git Blame', () => {
  it('anota el archivo con el autor de cada línea, se actualiza al editar y se cierra', async () => {
    const api = await vscode.extensions.getExtension<MultiGitTestApi>('angelminga-multigit.multigit')!.activate();
    const repo = api.manager.all.find((r) => r.name === 'shell')!;
    const file = vscode.Uri.file(path.join(repo.root, 'package.json'));
    await vscode.commands.executeCommand('multigit.file.blame', file);
    // El comando no espera a terminar: se espera a que el archivo quede anotado.
    let lines = api.blame.linesOf(file);
    for (let i = 0; i < 50 && !lines; i++) {
      await new Promise((r) => setTimeout(r, 100));
      lines = api.blame.linesOf(file);
    }
    const editor = vscode.window.activeTextEditor!;
    assert.equal(editor.document.uri.fsPath, file.fsPath);
    assert.ok(lines?.length, 'el archivo queda anotado');
    // VS Code cuenta la línea vacía tras el último salto de línea; git blame no.
    assert.equal(lines.length, editor.document.lineCount - (editor.document.getText().endsWith('\n') ? 1 : 0));
    assert.ok(lines.every((l) => l.hash.length === 40 && l.summary !== undefined));

    // Una línea nueva sin guardar aparece como "sin commit".
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'nueva\n'));
    let fresh: readonly { hash: string }[] | undefined;
    for (let i = 0; i < 40 && fresh?.[0]?.hash !== '0'.repeat(40); i++) {
      await new Promise((r) => setTimeout(r, 100));
      fresh = api.blame.linesOf(file);
    }
    assert.equal(fresh?.[0]?.hash, '0'.repeat(40));
    await vscode.commands.executeCommand('undo');

    await vscode.commands.executeCommand('multigit.blame.close');
    assert.equal(api.blame.linesOf(file), undefined);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
});
