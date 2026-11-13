// Vista Repositorios, barra de estado, popup de ramas, push/pull/fetch y proveedores de contenido.
import * as vscode from 'vscode';
import { AutoFetcher } from '../git/AutoFetcher';
import { GitContentProvider } from '../git/GitContentProvider';
import type { Repo, RepoManager } from '../git/RepoManager';
import { BranchDecorations } from '../views/BranchDecorations';
import { CompareView } from '../views/compareView';
import { PullPanel } from '../webview/PullPanel';
import { RemotesPanel } from '../webview/RemotesPanel';
import { RepoDecorations } from '../views/RepoDecorations';
import { RepositoriesView } from '../views/RepositoriesView';
import { StatusBar } from '../views/StatusBar';
import type { Core } from './core';
import { newRepoGroup, selectRepoGroup } from '../views/repoGroups';
import { createPullRequests } from '../views/pullRequests';
import { t } from '../i18n';

export function registerRepositories(core: Core, compareView: CompareView): { treeView: vscode.TreeView<Repo>; view: RepositoriesView } {
  const { manager, popup, log } = core;
  const view = new RepositoriesView(manager);
  const decorations = new RepoDecorations(manager);
  const treeView = vscode.window.createTreeView('multigit.repositories', { treeDataProvider: view, showCollapseAll: false });

  const describeGroup = () => {
    treeView.description = manager.activeGroup ? `$(filter) ${manager.activeGroup}` : undefined;
  };
  describeGroup();

  core.track(
    manager.onDidChange(describeGroup),
    vscode.commands.registerCommand('multigit.selectRepoGroup', () => popup.safely(() => selectRepoGroup(manager))),
    vscode.commands.registerCommand('multigit.selectRepoGroupActive', () => popup.safely(() => selectRepoGroup(manager))),
    vscode.commands.registerCommand('multigit.createPullRequests', (repo?: Repo) =>
      popup.safely(() => createPullRequests(manager, (repos) => core.openPush(repos), repo ? [repo] : undefined)),
    ),
    vscode.commands.registerCommand('multigit.createPullRequests.forRepos', (repos: readonly Repo[]) =>
      popup.safely(() => createPullRequests(manager, (r) => core.openPush(r), repos.length ? repos : undefined)),
    ),
    vscode.commands.registerCommand('multigit.manageRemotes', () => popup.safely(() => RemotesPanel.open(core.context.extensionUri, manager))),
    vscode.commands.registerCommand('multigit.newRepoGroup', () => popup.safely(() => newRepoGroup(manager))),
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
    vscode.commands.registerCommand('multigit.pull', (repo?: Repo) => popup.safely(() => PullPanel.open(core.context.extensionUri, manager, repo))),
    vscode.commands.registerCommand('multigit.refresh', () =>
      vscode.window.withProgress(
        { location: { viewId: 'multigit.repositories' }, title: t('Refreshing repositories…') },
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
      core.actions.updateProject({ repos: manager.all, label: t('all repositories') }),
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
    vscode.window.setStatusBarMessage(t('$(check) MultiGit: fetch completed in {0} repos', results.length), 4000);
    return;
  }
  const lines = results.map((r) => (r.error ? `❌ ${r.repo.name}: ${firstLine(r.error)}` : `✅ ${r.repo.name}`));
  void vscode.window.showWarningMessage(t('MultiGit: fetch failed in {0} repo(s).', failed.length), {
    modal: true,
    detail: lines.join('\n'),
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? text;
}
