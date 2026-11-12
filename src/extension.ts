import * as vscode from 'vscode';
import { AutoFetcher } from './git/AutoFetcher';
import { RepoManager } from './git/RepoManager';
import { BranchActions } from './views/branchActions';
import { BranchPopup } from './views/branchPopup';
import { CompareView } from './views/compareView';
import { RepoDecorations } from './views/RepoDecorations';
import { RepositoriesView } from './views/RepositoriesView';
import { StatusBar } from './views/StatusBar';
import type { Repo } from './git/RepoManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('MultiGit', { log: true });
  const manager = new RepoManager(log);
  const repositoriesView = new RepositoriesView(manager);
  const decorations = new RepoDecorations(manager);
  const compareView = new CompareView();
  const popup = new BranchPopup(manager, new BranchActions(manager, compareView));
  const treeView = vscode.window.createTreeView('multigit.repositories', {
    treeDataProvider: repositoriesView,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    log,
    manager,
    repositoriesView,
    decorations,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    compareView,
    vscode.workspace.registerTextDocumentContentProvider(CompareView.scheme, compareView),
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
  );

  log.info('MultiGit activado.');
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

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
