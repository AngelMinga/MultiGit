// Operaciones a medias (merge / rebase…) y alineación de ramas.
import * as vscode from 'vscode';
import { computeAlignment } from '../git/alignment';
import type { Repo } from '../git/RepoManager';
import { OperationsBar } from '../views/OperationsBar';
import type { Core } from './core';

export function registerOperations(core: Core, repositories: vscode.TreeView<Repo>): void {
  const { manager, actions } = core;
  const bar = new OperationsBar(manager);
  const repoArg = (repo?: Repo) => repo ?? repositories.selection[0];
  core.track(
    bar,
    vscode.commands.registerCommand('multigit.operation.menu', () => bar.showMenu()),
    vscode.commands.registerCommand('multigit.operation.resolve', (repo?: Repo) => {
      const r = repoArg(repo);
      return r && bar.resolve(r);
    }),
    vscode.commands.registerCommand('multigit.operation.continue', (repo?: Repo) => {
      const r = repoArg(repo);
      return r && bar.continue(r);
    }),
    vscode.commands.registerCommand('multigit.operation.abort', (repo?: Repo) => {
      const r = repoArg(repo);
      return r && bar.abort(r);
    }),
    vscode.commands.registerCommand('multigit.alignBranches', async () => {
      const alignment = computeAlignment(manager.all);
      if (!alignment) {
        void vscode.window.showInformationMessage('MultiGit: todos los repos están en la misma rama.');
        return;
      }
      await actions.alignTo(alignment.target, manager.all.filter((r) => alignment.outliers.some((o) => o.repo === r.name)));
    }),
  );
}
