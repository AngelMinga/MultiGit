// Barra de estado: "⎇ rama" si todos los repos están en la misma, o "⎇ N ramas" si difieren.
// Al hacer clic abre el popup de ramas (comando multigit.branches).
import * as vscode from 'vscode';
import { summarizeBranches, sumCounters } from '../git/branchSummary';
import type { RepoManager } from '../git/RepoManager';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    this.item = vscode.window.createStatusBarItem('multigit.branch', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'MultiGit: rama';
    this.item.command = 'multigit.branches';
    this.subscription = manager.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const repos = this.manager.all;
    const summary = summarizeBranches(repos);
    if (summary.kind === 'empty') {
      this.item.hide();
      return;
    }

    const { ahead, behind, dirtyRepos } = sumCounters(repos.map((r) => r.status));
    const counters = [ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(' ');
    const label = summary.kind === 'single' ? summary.branch : `${summary.byBranch.length} ramas`;
    this.item.text = `$(git-branch) ${label}${counters ? ` ${counters}` : ''}`;

    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**MultiGit** — ${repos.length} repositorios\n\n`);
    if (summary.kind === 'single') {
      md.appendMarkdown(`Todos en \`${summary.branch}\`\n\n`);
    } else {
      for (const group of summary.byBranch) {
        md.appendMarkdown(`$(git-branch) \`${group.branch}\`: ${group.repos.join(', ')}\n\n`);
      }
    }
    if (ahead || behind) md.appendMarkdown(`↑${ahead} por subir · ↓${behind} por bajar\n\n`);
    if (dirtyRepos) md.appendMarkdown(`${dirtyRepos} repo(s) con cambios sin commit\n\n`);
    md.appendMarkdown('_Clic para ver las ramas_');
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
