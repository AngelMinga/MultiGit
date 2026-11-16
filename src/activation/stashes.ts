// Vista Stashes: árbol de stashes de todos los repos y sus acciones.
import * as vscode from 'vscode';
import { StashActions } from '../views/stashActions';
import { ShelfActions } from '../views/shelfActions';
import { StashesTree, type StashNode } from '../views/StashesTree';
import type { Core } from './core';

export function registerStashes(core: Core): { tree: StashesTree; view: vscode.TreeView<StashNode> } {
  const { manager, popup } = core;
  const tree = new StashesTree(manager);
  const view = vscode.window.createTreeView('multigit.stashes', { treeDataProvider: tree, showCollapseAll: true });
  const actions = new StashActions(manager, tree);

  // Releer solo si la vista está visible; si no, al volver a mostrarla.
  let stale = false;
  const refresh = () => {
    if (view.visible) tree.refresh();
    else stale = true;
  };
  const targets = (node?: StashNode) => {
    const target = node ?? view.selection[0];
    return target ? tree.targetsOf(target) : [];
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
    vscode.commands.registerCommand('multigit.stashes.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('multigit.stashes.create', () => popup.safely(() => actions.create())),
    vscode.commands.registerCommand('multigit.stashes.clear', () => popup.safely(() => actions.clear())),
    vscode.commands.registerCommand('multigit.stashes.apply', (node?: StashNode) => popup.safely(() => actions.apply(targets(node), false))),
    vscode.commands.registerCommand('multigit.stashes.pop', (node?: StashNode) => popup.safely(() => actions.apply(targets(node), true))),
    vscode.commands.registerCommand('multigit.stashes.drop', (node?: StashNode) => popup.safely(() => actions.drop(targets(node)))),
    vscode.commands.registerCommand('multigit.stashes.branch', (node?: StashNode) => popup.safely(() => actions.branch(targets(node)))),
    vscode.commands.registerCommand('multigit.stashes.openDiff', (node?: StashNode) => {
      const target = node ?? view.selection[0];
      return target ? popup.safely(() => actions.openDiff(target)) : undefined;
    }),
  );

  // Vista Shelf (como IntelliJ): los guardados con Shelve. Varios archivos elegidos → Unshelve de esos.
  const shelfTree = new StashesTree(manager, 'shelf');
  const shelfView = vscode.window.createTreeView('multigit.shelf', { treeDataProvider: shelfTree, showCollapseAll: true, canSelectMany: true });
  const shelf = new ShelfActions(manager, shelfTree, new StashActions(manager, shelfTree));
  let shelfStale = false;
  const shelfTargets = (node?: StashNode) => {
    const target = node ?? shelfView.selection[0];
    return target ? shelfTree.targetsOf(target) : [];
  };
  /** Archivos elegidos: los seleccionados si el clic fue sobre uno de ellos; si no, el del clic. */
  const shelfFiles = (node?: StashNode, selected?: readonly StashNode[]): StashNode[] => {
    const list = selected?.length ? selected : node ? [node] : shelfView.selection;
    return list.filter((n) => n.kind === 'file');
  };
  core.track(
    shelfTree,
    shelfView,
    manager.onDidChange(() => {
      if (shelfView.visible) shelfTree.refresh();
      else shelfStale = true;
    }),
    shelfView.onDidChangeVisibility((e) => {
      if (e.visible && shelfStale) {
        shelfStale = false;
        shelfTree.refresh();
      }
    }),
    vscode.commands.registerCommand('multigit.shelf.refresh', () => shelfTree.refresh()),
    vscode.commands.registerCommand('multigit.shelf.unshelve', (node?: StashNode) => popup.safely(() => shelf.unshelve(shelfTargets(node)))),
    vscode.commands.registerCommand('multigit.shelf.unshelveFiles', (node?: StashNode, selected?: StashNode[]) =>
      popup.safely(() => shelf.unshelveFiles(shelfFiles(node, selected))),
    ),
    vscode.commands.registerCommand('multigit.shelf.rename', (node?: StashNode) => popup.safely(() => shelf.rename(shelfTargets(node)))),
    vscode.commands.registerCommand('multigit.shelf.delete', (node?: StashNode) => popup.safely(() => shelf.remove(shelfTargets(node)))),
    vscode.commands.registerCommand('multigit.shelf.openDiff', (node?: StashNode) => {
      const target = node ?? shelfView.selection[0];
      return target ? popup.safely(() => actions.openDiff(target)) : undefined;
    }),
  );
  return { tree, view };
}
