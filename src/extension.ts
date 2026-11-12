import * as vscode from 'vscode';
import { AutoFetcher } from './git/AutoFetcher';
import { RepoManager } from './git/RepoManager';
import { BranchActions, type BranchRef, type Scope } from './views/branchActions';
import { BranchPopup } from './views/branchPopup';
import { BranchesTree, type BranchNode } from './views/BranchesTree';
import { CompareView } from './views/compareView';
import { RepoDecorations } from './views/RepoDecorations';
import { RepositoriesView } from './views/RepositoriesView';
import { StatusBar } from './views/StatusBar';
import { RepoIcons } from './views/repoIcons';
import { ToolbarView } from './views/ToolbarView';
import { GitContentProvider } from './git/GitContentProvider';
import { PushPanel } from './webview/PushPanel';
import { LogView } from './webview/LogView';
import { FileActions } from './views/fileActions';
import { showPullDialog } from './views/pullDialog';
import { ChangesActions } from './views/changesActions';
import { ChangesTree, filesOf, type ChangeNode, type FileRef } from './views/ChangesTree';
import { CommitView } from './views/CommitView';
import { installTranslations } from './views/claudeCommit';
import type { Repo } from './git/RepoManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('MultiGit', { log: true });
  installTranslations();
  const manager = new RepoManager(log);
  const repositoriesView = new RepositoriesView(manager);
  const decorations = new RepoDecorations(manager);
  const compareView = new CompareView();
  const openPush = (repos?: readonly Repo[], branch?: string) =>
    PushPanel.open(context.extensionUri, manager, { repos, branch });
  const actions = new BranchActions(manager, compareView, (scope, branch) => openPush(scope.repos, branch));
  const repoIcons = new RepoIcons(context.globalStorageUri, context.extension.packageJSON);
  void repoIcons.init();
  const popup = new BranchPopup(manager, actions, repoIcons);
  const treeView = vscode.window.createTreeView('multigit.repositories', {
    treeDataProvider: repositoriesView,
    showCollapseAll: false,
  });
  const branchesTree = new BranchesTree(manager, context.globalState);
  const branchesView = vscode.window.createTreeView('multigit.branches', {
    treeDataProvider: branchesTree,
    showCollapseAll: true,
  });
  // Releer ramas solo si la vista está visible; si no, al volver a mostrarla.
  let branchesStale = false;
  const refreshBranches = () => {
    if (branchesView.visible) branchesTree.refresh();
    else branchesStale = true;
  };
  const branchActionsFor = (node?: BranchNode) => {
    const target = node ?? branchesView.selection[0];
    return target ? branchesTree.scopeOf(target) : undefined;
  };

  context.subscriptions.push(
    log,
    manager,
    repositoriesView,
    decorations,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    compareView,
    vscode.workspace.registerTextDocumentContentProvider(CompareView.scheme, compareView),
    vscode.workspace.registerTextDocumentContentProvider(GitContentProvider.scheme, new GitContentProvider(manager)),
    vscode.commands.registerCommand('multigit.push', (repo?: Repo) => openPush(repo ? [repo] : undefined)),
    vscode.commands.registerCommand('multigit.pull', (repo?: Repo) => showPullDialog(manager, repo)),
    branchesTree,
    branchesView,
    manager.onDidChange(refreshBranches),
    branchesView.onDidChangeVisibility((e) => {
      if (e.visible && branchesStale) {
        branchesStale = false;
        branchesTree.refresh();
      }
    }),
    vscode.commands.registerCommand('multigit.branchesTree.actions', (node?: BranchNode) => {
      const target = branchActionsFor(node);
      if (target) void popup.safely(() => popup.showBranchActions(target.scope, target.ref));
    }),
    vscode.commands.registerCommand('multigit.branchesTree.rename', (node?: BranchNode) => {
      const target = branchActionsFor(node);
      const ref = target?.ref;
      if (target && ref?.type === 'local') void popup.safely(() => actions.rename(target.scope, ref));
    }),
    // Menú contextual de la vista Ramas (como el de IntelliJ). Cada comando recibe el nodo.
    ...(
      [
        ['checkout', (sc, ref) => actions.checkout(sc, ref)],
        ['newBranchFrom', (sc, ref) => actions.newBranch(sc, ref)],
        ['checkoutAndRebase', (sc, ref) => (ref.type === 'local' ? actions.checkoutAndRebase(sc, ref) : undefined)],
        ['compare', (sc, ref) => actions.compare(sc, ref)],
        ['diffWorkingTree', (sc, ref) => actions.diffWithWorkingTree(sc, ref)],
        ['rebaseOnto', (sc, ref) => actions.rebaseOnto(sc, ref)],
        ['merge', (sc, ref) => actions.merge(sc, ref)],
        ['newWorktree', (sc, ref) => actions.newWorktree(sc, ref)],
        ['update', (sc, ref) => actions.update(sc, ref)],
        ['push', (sc, ref) => (ref.type === 'local' ? actions.push(sc, ref.name) : undefined)],
        ['delete', (sc, ref) => (ref.type === 'local' ? actions.deleteLocal(sc, ref) : actions.deleteRemote(sc, ref))],
      ] as Array<[string, (scope: Scope, ref: BranchRef) => Promise<unknown> | undefined]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.branch.${id}`, (node?: BranchNode) => {
        const target = branchActionsFor(node);
        if (target) void popup.safely(async () => run(target.scope, target.ref));
      }),
    ),
    // Opciones de la vista Ramas (menú ⋯), como el panel de ramas de IntelliJ.
    vscode.commands.registerCommand('multigit.branches.click.actions', () => branchesTree.setOption('clickMode', 'actions')),
    vscode.commands.registerCommand('multigit.branches.click.filter', () => branchesTree.setOption('clickMode', 'filter')),
    vscode.commands.registerCommand('multigit.branches.click.navigate', () => branchesTree.setOption('clickMode', 'navigate')),
    vscode.commands.registerCommand('multigit.branches.toggleByRepo', () => branchesTree.toggle('byRepo')),
    vscode.commands.registerCommand('multigit.branches.toggleByDir', () => branchesTree.toggle('byDir')),
    vscode.commands.registerCommand('multigit.branches.toggleTags', () => {
      branchesTree.toggle('showTags');
      branchesTree.refresh();
    }),
    vscode.commands.registerCommand('multigit.branchesTree.refresh', () => branchesTree.refresh()),
    new StatusBar(manager),
    new AutoFetcher(manager, log),
    vscode.commands.registerCommand('multigit.refresh', () =>
      vscode.window.withProgress(
        { location: { viewId: 'multigit.repositories' }, title: 'Refrescando repositorios…' },
        () => manager.refresh(),
      ),
    ),
    vscode.commands.registerCommand('multigit.fetch', () => fetchWithProgress(manager)),
    vscode.commands.registerCommand('multigit.branches', () => popup.show()),
    vscode.commands.registerCommand('multigit.repoBranches', (repo?: Repo) =>
      popup.show(repo ?? treeView.selection[0]),
    ),
    vscode.commands.registerCommand('multigit.branchPopup.rename', () => popup.renameActive()),
    vscode.commands.registerCommand('multigit.showLog', () => log.show(true)),
    // Enfocar una vista oculta la vuelve visible.
    vscode.commands.registerCommand('multigit.showBranchesView', () =>
      vscode.commands.executeCommand('multigit.branches.focus'),
    ),
  );

  // ---------------------------------------------------------------- Changes + Commit (Fase 5)
  const changesTree = new ChangesTree(manager, context.globalState);
  const changesView = vscode.window.createTreeView('multigit.changes', {
    treeDataProvider: changesTree,
    canSelectMany: true,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  });
  const changesActions = new ChangesActions(manager, changesTree);
  const commitView = new CommitView(context.extensionUri, manager, changesTree, changesActions, (repos) => openPush(repos));
  let changesStale = true;
  const refreshChanges = () => {
    if (changesView.visible) {
      changesStale = false;
      void changesTree.refresh();
    } else {
      changesStale = true;
    }
  };
  const updateChangesBadge = () => {
    const n = changesTree.trackedFiles.length;
    changesView.badge = n ? { value: n, tooltip: `${n} archivo(s) con cambios` } : undefined;
  };
  const fileNode = (node?: ChangeNode) => (node?.kind === 'file' ? node.ref : undefined);

  context.subscriptions.push(
    changesTree,
    changesView,
    commitView,
    vscode.window.registerWebviewViewProvider(CommitView.viewId, commitView, { webviewOptions: { retainContextWhenHidden: true } }),
    manager.onDidChange(refreshChanges),
    changesTree.onDidChangeChecked(updateChangesBadge),
    changesView.onDidChangeVisibility((e) => {
      if (e.visible && changesStale) refreshChanges();
    }),
    changesView.onDidChangeCheckboxState((e) => changesTree.onCheckboxChange(e)),
    vscode.commands.registerCommand('multigit.commitFocus', () => commitView.focus()),
    vscode.commands.registerCommand('multigit.updateProject', () =>
      actions.updateProject({ repos: manager.all, label: 'todos los repositorios' }),
    ),
    vscode.commands.registerCommand('multigit.changes.refresh', () => changesTree.refresh()),
    vscode.commands.registerCommand('multigit.changes.toggleGroupByRepo', () => changesTree.toggleGrouping('repo')),
    vscode.commands.registerCommand('multigit.changes.toggleGroupByDir', () => changesTree.toggleGrouping('directory')),
    vscode.commands.registerCommand('multigit.changes.rollback', (node?: ChangeNode, nodes?: ChangeNode[]) =>
      changesActions.rollback(node ? refsOf(node, nodes) : undefined, !!node),
    ),
    vscode.commands.registerCommand('multigit.changes.shelve', (node?: ChangeNode, nodes?: ChangeNode[]) =>
      changesActions.shelve(node ? refsOf(node, nodes) : undefined),
    ),
    // Menú contextual de Changes (como IntelliJ). Reciben el nodo y, con selección múltiple, todos los elegidos.
    ...(
      [
        ['commitOnly', (refs) => changesActions.commitOnly(refs)],
        ['addToVcs', (refs) => changesActions.addToVcs(refs)],
        ['excludeLocal', (refs) => changesActions.ignore(refs, 'exclude')],
        ['addToGitignore', (refs) => changesActions.ignore(refs, 'gitignore')],
        ['delete', (refs) => changesActions.deleteFiles(refs)],
        ['copyPatch', (refs) => changesActions.copyPatch(refs)],
      ] as Array<[string, (refs: FileRef[]) => Promise<unknown>]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.changes.${id}`, (node?: ChangeNode, nodes?: ChangeNode[]) => {
        const refs = refsOf(node ?? changesView.selection[0], nodes ?? (node ? undefined : [...changesView.selection]));
        if (refs.length) void popup.safely(() => run(refs));
      }),
    ),
    // Submenú Git: acciones del repo del elemento.
    ...(
      [
        ['push', (repo) => vscode.commands.executeCommand('multigit.push', repo)],
        ['pull', (repo) => vscode.commands.executeCommand('multigit.pull', repo)],
        ['fetch', () => vscode.commands.executeCommand('multigit.fetch')],
        ['branches', (repo) => vscode.commands.executeCommand('multigit.repoBranches', repo)],
        ['newBranch', (repo) => actions.newBranch({ repos: [repo], label: repo.name })],
        ['log', (repo) => logView.showBranch(null, [repo.root])],
      ] as Array<[string, (repo: Repo) => unknown]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.changes.git.${id}`, (node?: ChangeNode) => {
        const repo = repoOf(node ?? changesView.selection[0]);
        if (repo) void popup.safely(async () => run(repo));
      }),
    ),
    vscode.commands.registerCommand('multigit.changes.unshelve', () => changesActions.unshelve()),
    vscode.commands.registerCommand('multigit.changes.openDiff', (node?: ChangeNode) => {
      const ref = fileNode(node ?? changesView.selection[0]);
      if (ref) void changesActions.openDiff(ref);
    }),
    vscode.commands.registerCommand('multigit.changes.openFile', (node?: ChangeNode) => {
      const ref = fileNode(node ?? changesView.selection[0]);
      if (ref) void changesActions.openFile(ref);
    }),
  );

  // ---------------------------------------------------------------- Git Log (Fase 6)
  const logView = new LogView(context.extensionUri, manager, actions);
  context.subscriptions.push(
    logView,
    vscode.window.registerWebviewViewProvider(LogView.viewId, logView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('multigit.openGitLog', () => vscode.commands.executeCommand(`${LogView.viewId}.focus`)),
    vscode.commands.registerCommand('multigit.log.showBranch', (branch?: string | null, repoIds?: string[]) =>
      logView.showBranch(branch ?? null, repoIds ?? []),
    ),
    vscode.commands.registerCommand('multigit.branchesTree.showInLog', (node?: BranchNode) => {
      const target = branchesTree.logTargetOf(node ?? branchesView.selection[0]!);
      if (target) return logView.showBranch(target.ref, target.repoIds);
    }),
    vscode.commands.registerCommand('multigit.branchesTree.navigateLog', (node?: BranchNode) => {
      const target = branchesTree.logTargetOf(node ?? branchesView.selection[0]!);
      if (target) return logView.navigateTo(target.ref, target.repoIds);
    }),
    // Clic en un tag con "Show Actions": acciones del tag.
    vscode.commands.registerCommand('multigit.branchesTree.tagActions', async (node?: BranchNode) => {
      const target = branchesTree.logTargetOf(node ?? branchesView.selection[0]!);
      if (!target || node?.kind !== 'tag') return;
      const repos = node.repos;
      const scopeLabel = repos.length === 1 ? repos[0]!.name : `${repos.length} repositorios`;
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(check) Checkout (HEAD detached)', id: 'checkout' },
          { label: '$(history) Show in Git Log', id: 'log' },
          { label: '$(arrow-right) Navigate Log to Tag', id: 'navigate' },
          { label: '$(git-compare) Compare with Current', id: 'compare' },
        ],
        { title: `Tag '${node.name}' — ${scopeLabel}` },
      );
      if (!picked) return;
      const scope = { repos, label: scopeLabel };
      const ref = { type: 'local' as const, name: target.ref };
      if (picked.id === 'checkout') await popup.safely(() => actions.checkoutRef(scope, target.ref));
      if (picked.id === 'log') await logView.showBranch(target.ref, target.repoIds);
      if (picked.id === 'navigate') await logView.navigateTo(target.ref, target.repoIds);
      if (picked.id === 'compare') await popup.safely(() => actions.compare(scope, ref));
    }),
  );

  // ---------------------------------------------------------------- Proyecto (botones estilo IntelliJ)
  const toolbarView = new ToolbarView(context.extensionUri, manager);
  context.subscriptions.push(
    toolbarView,
    vscode.window.registerWebviewViewProvider(ToolbarView.viewId, toolbarView),
  );

  // ---------------------------------------------------------------- Acciones por archivo (submenú Git)
  const fileActions = new FileActions(manager, logView, changesActions, changesTree);
  type FileArg = vscode.Uri | ChangeNode | undefined;
  context.subscriptions.push(
    ...(
      [
        ['showHistory', (a) => fileActions.showHistory(a)],
        ['blame', (a) => fileActions.blame(a)],
        ['showDiff', (a) => fileActions.showDiff(a)],
        ['compareRevision', (a) => fileActions.compareWithRevision(a)],
        ['compareRef', (a) => fileActions.compareWithRef(a)],
        ['currentRevision', (a) => fileActions.showCurrentRevision(a)],
        ['add', (a) => fileActions.add(a)],
        ['rollback', (a) => fileActions.rollback(a)],
        ['localHistory', (a) => fileActions.localHistory('show', a)],
        ['projectHistory', () => fileActions.localHistory('project')],
        ['putLabel', (a) => fileActions.localHistory('label', a)],
        [
          'commitFile',
          async (a) => {
            const t = fileActions.resolve(a);
            if (!t) return;
            await changesTree.refresh();
            const ref = changesTree.checkedFiles.concat(changesTree.trackedFiles).find((r) => r.repo === t.repo && r.file.path === t.rel)
              ?? (await t.repo.git.getChanges()).map((file) => ({ repo: t.repo, file })).find((r) => r.file.path === t.rel);
            if (!ref) {
              void vscode.window.showInformationMessage('MultiGit: el archivo no tiene cambios para commitear.');
              return;
            }
            await changesActions.commitOnly([ref]);
          },
        ],
        ['push', (a) => vscode.commands.executeCommand('multigit.push', fileActions.resolve(a)?.repo)],
        ['pull', (a) => vscode.commands.executeCommand('multigit.pull', fileActions.resolve(a)?.repo)],
        ['branches', (a) => vscode.commands.executeCommand('multigit.repoBranches', fileActions.resolve(a)?.repo)],
      ] as Array<[string, (arg: FileArg) => unknown]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.file.${id}`, (arg?: FileArg) => void popup.safely(async () => run(arg))),
    ),
  );

  log.info('MultiGit activado.');
  void revealNewViewsOnce(context, log);
  try {
    await manager.initialize();
  } catch (error) {
    log.error('Error al inicializar MultiGit', error);
    void vscode.window.showErrorMessage(`MultiGit: no se pudieron cargar los repositorios. ${String(error)}`);
  }
}

/** Archivos de los nodos elegidos (sin repetir). */
function refsOf(node?: ChangeNode, nodes?: readonly ChangeNode[]): FileRef[] {
  const all = (nodes?.length ? nodes : node ? [node] : []).flatMap((n) => filesOf(n));
  const seen = new Set<string>();
  return all.filter((r) => {
    const k = `${r.repo.root}\0${r.file.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Repo de un nodo de Changes (el del archivo, o el único de la carpeta/sección). */
function repoOf(node?: ChangeNode): Repo | undefined {
  if (!node) return undefined;
  if (node.kind === 'repo') return node.repo;
  const repos = [...new Set(filesOf(node).map((r) => r.repo))];
  return repos.length === 1 ? repos[0] : undefined;
}

async function fetchWithProgress(manager: RepoManager): Promise<void> {
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MultiGit: Fetch', cancellable: false },
    (progress) =>
      manager.fetchAll((done, total, repo) => {
        progress.report({ message: `${done}/${total} ${repo.name}…`, increment: 100 / total });
      }),
  );

  const failed = results.filter((r) => r.error);
  if (failed.length === 0) {
    vscode.window.setStatusBarMessage(`$(check) MultiGit: fetch completado en ${results.length} repos`, 4000);
    return;
  }
  const lines = results.map((r) => (r.error ? `❌ ${r.repo.name}: ${firstLine(r.error)}` : `✅ ${r.repo.name}`));
  void vscode.window.showWarningMessage(`MultiGit: el fetch falló en ${failed.length} repo(s).`, {
    modal: true,
    detail: lines.join('\n'),
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? text;
}

/**
 * VS Code recuerda qué vistas tenía visibles el contenedor MultiGit y deja ocultas las que se
 * agregan en versiones nuevas. Enfocar una vista la vuelve visible; se hace una sola vez por vista
 * y luego el usuario decide (puede ocultarlas o moverlas).
 */
async function revealNewViewsOnce(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  // 'multigit.branchesViewRevealed' es la clave de la 0.0.6 (vista Ramas).
  const views = [
    { id: 'multigit.branches', key: 'multigit.branchesViewRevealed' },
    { id: 'multigit.changes', key: 'multigit.viewRevealed.changes' },
    { id: 'multigit.commit', key: 'multigit.viewRevealed.commit' },
    // 0.1.5: la vista Proyecto pasó al Explorer; se muestra una vez allí.
    { id: 'multigit.toolbar', key: 'multigit.viewRevealed.toolbarExplorer' },
  ].filter((v) => !context.globalState.get<boolean>(v.key));
  if (views.length === 0) return;
  for (const view of views) {
    try {
      await vscode.commands.executeCommand(`${view.id}.focus`);
      await context.globalState.update(view.key, true);
      log.info(`Vista ${view.id} mostrada.`);
    } catch (error) {
      log.error(`No se pudo mostrar la vista ${view.id}`, error);
    }
  }
  await vscode.commands.executeCommand('multigit.changes.focus').then(undefined, () => undefined);
}

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
