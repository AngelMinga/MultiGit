// Vista Stashes: árbol de stashes de todos los repos y sus acciones.
import * as vscode from 'vscode';
import { StashActions } from '../views/stashActions';
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
  return { tree, view };
}
