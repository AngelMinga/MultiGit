// Vista Repositorios, barra de estado, popup de ramas, push/pull/fetch y proveedores de contenido.
import * as vscode from 'vscode';
import { AutoFetcher } from '../git/AutoFetcher';
import { GitContentProvider } from '../git/GitContentProvider';
import type { Repo, RepoManager } from '../git/RepoManager';
import { BranchDecorations } from '../views/BranchDecorations';
import { CompareView } from '../views/compareView';
import { showPullDialog } from '../views/pullDialog';
import { RepoDecorations } from '../views/RepoDecorations';
import { RepositoriesView } from '../views/RepositoriesView';
import { StatusBar } from '../views/StatusBar';
import type { Core } from './core';

export function registerRepositories(core: Core, compareView: CompareView): { treeView: vscode.TreeView<Repo>; view: RepositoriesView } {
  const { manager, popup, log } = core;
  const view = new RepositoriesView(manager);
  const decorations = new RepoDecorations(manager);
  const treeView = vscode.window.createTreeView('multigit.repositories', { treeDataProvider: view, showCollapseAll: false });

  core.track(
    view,
    decorations,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.registerFileDecorationProvider(new BranchDecorations()),
    compareView,
    vscode.workspace.registerTextDocumentContentProvider(CompareView.scheme, compareView),
    vscode.workspace.registerTextDocumentContentProvider(GitContentProvider.scheme, new GitContentProvider(manager)),
    new StatusBar(manager),
    new AutoFetcher(manager, log),
    vscode.commands.registerCommand('multigit.push', (repo?: Repo) => core.openPush(repo ? [repo] : undefined)),
    vscode.commands.registerCommand('multigit.pull', (repo?: Repo) => showPullDialog(manager, repo)),
    vscode.commands.registerCommand('multigit.refresh', () =>
      vscode.window.withProgress(
        { location: { viewId: 'multigit.repositories' }, title: 'Refrescando repositorios…' },
        () => manager.refresh(),
      ),
    ),
    vscode.commands.registerCommand('multigit.fetch', () => fetchWithProgress(manager)),
    vscode.commands.registerCommand('multigit.branches', () => popup.show()),
    vscode.commands.registerCommand('multigit.repoBranches', (repo?: Repo) => popup.show(repo ?? treeView.selection[0])),
    vscode.commands.registerCommand('multigit.branchPopup.rename', () => popup.renameActive()),
    vscode.commands.registerCommand('multigit.showLog', () => log.show(true)),
    // Enfocar una vista oculta la vuelve visible.
    vscode.commands.registerCommand('multigit.showBranchesView', () => vscode.commands.executeCommand('multigit.branches.focus')),
    vscode.commands.registerCommand('multigit.updateProject', () =>
      core.actions.updateProject({ repos: manager.all, label: 'todos los repositorios' }),
    ),
  );
  return { treeView, view };
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
