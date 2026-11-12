// Popup de ramas. Versión provisional de la Fase 1: lista los repos agrupados por rama y
// al elegir uno lo selecciona en la vista. La Fase 2 lo reemplaza por el popup completo.
import * as vscode from 'vscode';
import { formatAheadBehind, summarizeBranches } from '../git/branchSummary';
import type { Repo, RepoManager } from '../git/RepoManager';

interface RepoPick extends vscode.QuickPickItem {
  repo?: Repo;
}

export async function showBranchesQuickPick(manager: RepoManager, treeView: vscode.TreeView<Repo>): Promise<void> {
  const repos = manager.all;
  const summary = summarizeBranches(repos);
  if (summary.kind === 'empty') {
    void vscode.window.showInformationMessage('MultiGit: no hay repositorios detectados.');
    return;
  }

  const groups = summary.kind === 'single' ? [{ branch: summary.branch, repos: summary.repos }] : summary.byBranch;
  const byName = new Map(repos.map((r) => [r.name, r]));
  const items: RepoPick[] = [];
  for (const group of groups) {
    items.push({ label: group.branch, kind: vscode.QuickPickItemKind.Separator });
    for (const name of group.repos) {
      const repo = byName.get(name);
      if (!repo?.status) continue;
      const changes = repo.status.changes.total;
      items.push({
        repo,
        label: `$(repo) ${repo.name}`,
        description: [formatAheadBehind(repo.status), changes ? `● ${changes}` : ''].filter(Boolean).join('  '),
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'MultiGit: ramas',
    placeHolder: 'Buscar repositorio…',
    matchOnDescription: true,
  });
  if (picked?.repo) await treeView.reveal(picked.repo, { select: true, focus: true });
}
