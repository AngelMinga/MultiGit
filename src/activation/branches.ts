// Vista Ramas: acciones por rama (menú contextual), opciones del menú ⋯ y enlaces con el Git Log.
import * as vscode from 'vscode';
import { refName, type BranchRef, type Scope } from '../views/branchActions';
import { BranchesTree, type BranchNode } from '../views/BranchesTree';
import type { LogView } from '../webview/LogView';
import type { Core } from './core';
import { t } from '../i18n';

export function registerBranches(core: Core, logView: LogView): { tree: BranchesTree; view: vscode.TreeView<BranchNode> } {
  const { manager, actions, popup, context } = core;
  const tree = new BranchesTree(manager, context.globalState);
  const view = vscode.window.createTreeView('multigit.branches', { treeDataProvider: tree, showCollapseAll: true });

  // Releer ramas solo si la vista está visible; si no, al volver a mostrarla.
  let stale = false;
  const refresh = () => {
    if (view.visible) tree.refresh();
    else stale = true;
  };
  const scopeFor = (node?: BranchNode) => {
    const target = node ?? view.selection[0];
    return target ? tree.scopeOf(target) : undefined;
  };
  const logTarget = (node?: BranchNode) => {
    const target = node ?? view.selection[0];
    return target ? tree.logTargetOf(target) : undefined;
  };

  core.track(
    tree,
    view,
    manager.onDidChange(refresh),
    view.onDidChangeVisibility((e) => {
      if (e.visible && stale) {
        stale = false;
        tree.refresh();
      }
    }),
    vscode.commands.registerCommand('multigit.branchesTree.actions', (node?: BranchNode) => {
      const target = scopeFor(node);
      if (target) void popup.safely(() => popup.showBranchActions(target.scope, target.ref));
    }),
    vscode.commands.registerCommand('multigit.branchesTree.rename', (node?: BranchNode) => {
      const target = scopeFor(node);
      const ref = target?.ref;
      if (target && ref?.type === 'local') void popup.safely(() => actions.rename(target.scope, ref));
    }),
    // Menú contextual (como el de IntelliJ). Cada comando recibe el nodo.
    ...(
      [
        ['checkout', (sc, ref) => actions.checkout(sc, ref)],
        ['newBranchFrom', (sc, ref) => actions.newBranch(sc, ref)],
        ['checkoutAndRebase', (sc, ref) => (ref.type === 'local' ? actions.checkoutAndRebase(sc, ref) : undefined)],
        ['compare', (sc, ref) => actions.compare(sc, ref)],
        ['compareFiles', (sc, ref) => vscode.commands.executeCommand('multigit.compareFiles.show', sc.repos, refName(ref))],
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
        const target = scopeFor(node);
        if (target) void popup.safely(async () => run(target.scope, target.ref));
      }),
    ),
    // Opciones del menú ⋯, como el panel de ramas de IntelliJ.
    vscode.commands.registerCommand('multigit.branches.click.actions', () => tree.setOption('clickMode', 'actions')),
    vscode.commands.registerCommand('multigit.branches.click.filter', () => tree.setOption('clickMode', 'filter')),
    vscode.commands.registerCommand('multigit.branches.click.navigate', () => tree.setOption('clickMode', 'navigate')),
    vscode.commands.registerCommand('multigit.branches.toggleByRepo', () => tree.toggle('byRepo')),
    vscode.commands.registerCommand('multigit.branches.toggleByDir', () => tree.toggle('byDir')),
    vscode.commands.registerCommand('multigit.branches.toggleTags', () => {
      tree.toggle('showTags');
      tree.refresh();
    }),
    vscode.commands.registerCommand('multigit.branchesTree.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('multigit.branchesTree.showInLog', (node?: BranchNode) => {
      const target = logTarget(node);
      if (target) return logView.showBranch(target.ref, target.repoIds);
    }),
    vscode.commands.registerCommand('multigit.branchesTree.navigateLog', (node?: BranchNode) => {
      const target = logTarget(node);
      if (target) return logView.navigateTo(target.ref, target.repoIds);
    }),
    // Clic en un tag con "Show Actions": acciones del tag.
    vscode.commands.registerCommand('multigit.branchesTree.tagActions', async (node?: BranchNode) => {
      const target = logTarget(node);
      if (!target || node?.kind !== 'tag') return;
      const repos = node.repos;
      const scopeLabel = repos.length === 1 ? repos[0]!.name : t('{0} repositories', repos.length);
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
      if (picked.id === 'checkout') await popup.safely(() => actions.checkoutRef(scope, target.ref));
      if (picked.id === 'log') await logView.showBranch(target.ref, target.repoIds);
      if (picked.id === 'navigate') await logView.navigateTo(target.ref, target.repoIds);
      if (picked.id === 'compare') await popup.safely(() => actions.compare(scope, { type: 'local', name: target.ref }));
    }),
  );
  return { tree, view };
}
