// Barra de estado: "⎇ rama" si todos los repos están en la misma, o "⎇ N ramas" si difieren.
// Al hacer clic abre el popup de ramas (comando multigit.branches).
import * as vscode from 'vscode';
import { alignmentKey, computeAlignment } from '../git/alignment';
import { summarizeBranches, sumCounters } from '../git/branchSummary';
import type { RepoManager } from '../git/RepoManager';
import { t } from '../i18n';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Nombre del proyecto (como el widget de proyecto de IntelliJ): abre los recientes. */
  private readonly project: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    // Prioridad alta: los dos quedan al principio de la barra de estado, a la izquierda.
    this.project = vscode.window.createStatusBarItem('multigit.project', vscode.StatusBarAlignment.Left, 1001);
    this.project.name = 'MultiGit: proyecto';
    this.project.command = 'workbench.action.openRecent';
    this.item = vscode.window.createStatusBarItem('multigit.branch', vscode.StatusBarAlignment.Left, 1000);
    this.item.name = t('MultiGit: branch');
    this.item.command = 'multigit.branches';
    this.subscription = manager.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const repos = this.manager.all;
    const summary = summarizeBranches(repos);
    void vscode.commands.executeCommand('setContext', 'multigit.hasRepos', summary.kind !== 'empty');
    if (summary.kind === 'empty') {
      this.item.hide();
      this.project.hide();
      return;
    }
    const projectName = vscode.workspace.name?.replace(/ \(Workspace\)$/, '') ?? 'MultiGit';
    const group = this.manager.activeGroup;
    this.project.text = `$(root-folder) ${projectName}${group ? ` $(filter) ${group}` : ''}`;
    this.project.tooltip = t('{0} — {1} repositories\nClick: open a recent project', projectName, repos.length);
    this.project.show();

    const { ahead, behind, dirtyRepos } = sumCounters(repos.map((r) => r.status));
    const counters = [ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(' ');
    // Desalineados: la rama de la mayoría con un aviso (⚠N repos en otra rama).
    const alignment = computeAlignment(repos);
    const label = alignment
      ? `${alignment.target} $(warning)${alignment.outliers.length}`
      : summary.kind === 'single'
        ? summary.branch
        : t('{0} branches', summary.byBranch.length);
    this.item.text = `$(git-branch) ${label}${counters ? ` ${counters}` : ''}`;
    this.notifyMisalignment(alignment);

    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(t('**MultiGit** — {0} repositories\n\n', repos.length));
    if (summary.kind === 'single') {
      md.appendMarkdown(t('All on `{0}`\n\n', summary.branch));
    } else {
      for (const group of summary.byBranch) {
        md.appendMarkdown(`$(git-branch) \`${group.branch}\`: ${group.repos.join(', ')}\n\n`);
      }
    }
    if (alignment) {
      md.appendMarkdown(
        t('$(warning) {0} repo(s) off `{1}`: {2}\n\n', alignment.outliers.length, alignment.target, alignment.outliers.map((o) => o.repo).join(', ')),
      );
    }
    if (ahead || behind) md.appendMarkdown(t('↑{0} to push · ↓{1} to pull\n\n', ahead, behind));
    if (dirtyRepos) md.appendMarkdown(t('{0} repo(s) with uncommitted changes\n\n', dirtyRepos));
    md.appendMarkdown(t('_Click to see the branches_'));
    this.item.tooltip = md;
    this.item.show();
  }

  /** Último aviso mostrado: solo se avisa cuando la desalineación aparece o cambia. */
  private lastAlignment = '';

  private notifyMisalignment(alignment: ReturnType<typeof computeAlignment>): void {
    const key = alignmentKey(alignment);
    if (key === this.lastAlignment) return;
    this.lastAlignment = key;
    if (!alignment || !vscode.workspace.getConfiguration('multigit').get<boolean>('warnBranchMismatch', true)) return;
    const ALIGN = t('Align with \'{0}\'', alignment.target);
    const NEVER = t('Don\'t Warn Again');
    const where = alignment.outliers.map((o) => t('{0} is on \'{1}\'', o.repo, o.branch)).join(', ');
    void vscode.window
      .showWarningMessage(
        t('MultiGit: {0}; the rest are on \'{1}\'.', where, alignment.target),
        ALIGN,
        NEVER,
      )
      .then((choice) => {
        if (choice === ALIGN) void vscode.commands.executeCommand('multigit.alignBranches');
        if (choice === NEVER) {
          void vscode.workspace.getConfiguration('multigit').update('warnBranchMismatch', false, vscode.ConfigurationTarget.Global);
        }
      });
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
    this.project.dispose();
  }
}
