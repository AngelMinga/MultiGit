// Vista Changes, caja de Commit, Rollback/Shelve y el menú contextual de Changes.
import * as vscode from 'vscode';
import type { Repo } from '../git/RepoManager';
import { ChangesActions } from '../views/changesActions';
import { ChangesTree, filesOf, type ChangeNode, type FileRef } from '../views/ChangesTree';
import { CommitView } from '../views/CommitView';
import type { LogView } from '../webview/LogView';
import type { Core } from './core';
import { t } from '../i18n';

export function registerChanges(
  core: Core,
  logView: LogView,
): { tree: ChangesTree; view: vscode.TreeView<ChangeNode>; actions: ChangesActions } {
  const { manager, context, popup } = core;
  const tree = new ChangesTree(manager, context.globalState);
  const view = vscode.window.createTreeView('multigit.changes', {
    treeDataProvider: tree,
    canSelectMany: true,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  });
  const actions = new ChangesActions(manager, tree, context.extensionUri);
  const commitView = new CommitView(context.extensionUri, manager, tree, actions, (repos) => core.openPush(repos), context.workspaceState);

  let stale = true;
  const refresh = () => {
    if (view.visible) {
      stale = false;
      void tree.refresh();
    } else {
      stale = true;
    }
  };
  const updateBadge = () => {
    const n = tree.trackedFiles.length;
    view.badge = n ? { value: n, tooltip: t('{0} file(s) with changes', n) } : undefined;
  };
  const fileNode = (node?: ChangeNode) => (node?.kind === 'file' ? node.ref : undefined);
  /** Nodo del clic y, con selección múltiple, todos los elegidos (o la selección si es un atajo). */
  const selected = (node?: ChangeNode, nodes?: ChangeNode[]) =>
    refsOf(node ?? view.selection[0], nodes ?? (node ? undefined : [...view.selection]));

  core.track(
    tree,
    view,
    commitView,
    vscode.window.registerWebviewViewProvider(CommitView.viewId, commitView, { webviewOptions: { retainContextWhenHidden: true } }),
    manager.onDidChange(refresh),
    tree.onDidChangeChecked(updateBadge),
    view.onDidChangeVisibility((e) => {
      if (e.visible && stale) refresh();
    }),
    view.onDidChangeCheckboxState((e) => tree.onCheckboxChange(e)),
    vscode.commands.registerCommand('multigit.commitFocus', () => commitView.focus()),
    vscode.commands.registerCommand('multigit.commit.history', () => popup.safely(() => commitView.requestHistory())),
    vscode.commands.registerCommand('multigit.changes.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('multigit.changes.toggleGroupByRepo', () => tree.toggleGrouping('repo')),
    vscode.commands.registerCommand('multigit.changes.toggleGroupByDir', () => tree.toggleGrouping('directory')),
    vscode.commands.registerCommand('multigit.changes.toggleGroupByModule', () => tree.toggleGrouping('module')),
    vscode.commands.registerCommand('multigit.changes.toggleShowIgnored', () => tree.toggleGrouping('showIgnored')),
    vscode.commands.registerCommand('multigit.changes.rollback', (node?: ChangeNode, nodes?: ChangeNode[]) =>
      actions.rollback(node ? refsOf(node, nodes) : undefined),
    ),
    vscode.commands.registerCommand('multigit.changes.shelve', (node?: ChangeNode, nodes?: ChangeNode[]) =>
      actions.shelve(node ? refsOf(node, nodes) : undefined),
    ),
    // Menú contextual (como IntelliJ).
    ...(
      [
        ['commitOnly', (refs) => actions.commitOnly(refs)],
        ['addToVcs', (refs) => actions.addToVcs(refs)],
        // "Add" del submenú Git (mismo comando que Add to VCS, con el nombre de IntelliJ).
        ['git.add', (refs) => actions.addToVcs(refs)],
        ['excludeLocal', (refs) => actions.ignore(refs, 'exclude')],
        ['addToGitignore', (refs) => actions.ignore(refs, 'gitignore')],
        ['ignoreNearest', (refs) => actions.ignore(refs, 'nearest')],
        ['ignoreRoot', (refs) => actions.ignore(refs, 'root')],
        ['delete', (refs) => actions.deleteFiles(refs)],
        ['copyPatch', (refs) => actions.copyPatch(refs)],
      ] as Array<[string, (refs: FileRef[]) => Promise<unknown>]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.changes.${id}`, (node?: ChangeNode, nodes?: ChangeNode[]) => {
        const refs = selected(node, nodes);
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
        ['newBranch', (repo) => core.actions.newBranch({ repos: [repo], label: repo.name })],
        ['log', (repo) => logView.showBranch(null, [repo.root])],
      ] as Array<[string, (repo: Repo) => unknown]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.changes.git.${id}`, (node?: ChangeNode) => {
        const repo = repoOf(node ?? view.selection[0]);
        if (repo) void popup.safely(async () => run(repo));
      }),
    ),
    vscode.commands.registerCommand('multigit.changes.unshelve', () => actions.unshelve()),
    vscode.commands.registerCommand('multigit.changes.openDiff', (node?: ChangeNode) => {
      const ref = fileNode(node ?? view.selection[0]);
      if (ref) void actions.openDiff(ref);
    }),
    vscode.commands.registerCommand('multigit.changes.openFile', (node?: ChangeNode) => {
      const ref = fileNode(node ?? view.selection[0]);
      if (ref) void actions.openFile(ref);
    }),
  );
  return { tree, view, actions };
}

/** Archivos de los nodos elegidos (sin repetir). */
export function refsOf(node?: ChangeNode, nodes?: readonly ChangeNode[]): FileRef[] {
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
