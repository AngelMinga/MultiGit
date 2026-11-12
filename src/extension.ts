import * as vscode from 'vscode';
import { AutoFetcher } from './git/AutoFetcher';
import { RepoManager } from './git/RepoManager';
import { BranchActions } from './views/branchActions';
import { BranchPopup } from './views/branchPopup';
import { BranchesTree, type BranchNode } from './views/BranchesTree';
import { CompareView } from './views/compareView';
import { RepoDecorations } from './views/RepoDecorations';
import { RepositoriesView } from './views/RepositoriesView';
import { StatusBar } from './views/StatusBar';
import { GitContentProvider } from './git/GitContentProvider';
import { PushPanel } from './webview/PushPanel';
import { showPullDialog } from './views/pullDialog';
import type { Repo } from './git/RepoManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('MultiGit', { log: true });
  const manager = new RepoManager(log);
  const repositoriesView = new RepositoriesView(manager);
  const decorations = new RepoDecorations(manager);
  const compareView = new CompareView();
  const openPush = (repos?: readonly Repo[], branch?: string) =>
    PushPanel.open(context.extensionUri, manager, { repos, branch });
  const actions = new BranchActions(manager, compareView, (scope, branch) => openPush(scope.repos, branch));
  const popup = new BranchPopup(manager, actions);
  const treeView = vscode.window.createTreeView('multigit.repositories', {
    treeDataProvider: repositoriesView,
    showCollapseAll: false,
  });
  const branchesTree = new BranchesTree(manager);
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
    vscode.commands.registerCommand('multigit.branchesTree.groupByBranch', () => branchesTree.setGroupBy('branch')),
    vscode.commands.registerCommand('multigit.branchesTree.groupByRepo', () => branchesTree.setGroupBy('repo')),
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

  log.info('MultiGit activado.');
  void revealBranchesViewOnce(context, log);
  try {
    await manager.initialize();
  } catch (error) {
    log.error('Error al inicializar MultiGit', error);
    void vscode.window.showErrorMessage(`MultiGit: no se pudieron cargar los repositorios. ${String(error)}`);
  }
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
 * VS Code recuerda qué vistas tenía visibles el contenedor antes de que existiera "Ramas" y puede
 * dejarla oculta. Enfocarla la vuelve visible; se hace una sola vez y luego el usuario decide.
 */
async function revealBranchesViewOnce(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  const key = 'multigit.branchesViewRevealed';
  if (context.globalState.get<boolean>(key)) return;
  try {
    await vscode.commands.executeCommand('multigit.branches.focus');
    await vscode.commands.executeCommand('multigit.repositories.focus');
    await context.globalState.update(key, true);
    log.info('Vista Ramas mostrada.');
  } catch (error) {
    log.error('No se pudo mostrar la vista Ramas', error);
  }
}

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
