// Vista Compare: archivos distintos entre otra rama y la actual (Compare Files with…).
import * as vscode from 'vscode';
import type { Repo } from '../git/RepoManager';
import { CompareFilesTree, type CompareNode } from '../views/CompareFilesTree';
import type { Core } from './core';

export function registerCompare(core: Core): CompareFilesTree {
  const { popup } = core;
  const tree = new CompareFilesTree();
  const view = vscode.window.createTreeView('multigit.compareFiles', { treeDataProvider: tree, showCollapseAll: true });
  tree.onDidChangeTitle = (description) => {
    view.description = description;
  };
  core.track(
    tree,
    view,
    vscode.commands.registerCommand('multigit.compareFiles.show', (repos: readonly Repo[], other: string) =>
      popup.safely(() => tree.compare(repos, other)),
    ),
    vscode.commands.registerCommand('multigit.compareFiles.openDiff', (node?: CompareNode) => {
      const target = node ?? view.selection[0];
      return target ? popup.safely(() => tree.openDiff(target)) : undefined;
    }),
    vscode.commands.registerCommand('multigit.compareFiles.refresh', () => popup.safely(() => tree.load())),
    vscode.commands.registerCommand('multigit.compareFiles.close', () => tree.close()),
  );
  return tree;
}
