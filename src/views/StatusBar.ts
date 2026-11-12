// Barra de estado: "⎇ rama" si todos los repos están en la misma, o "⎇ N ramas" si difieren.
// Al hacer clic abre el popup de ramas (comando multigit.branches).
import * as vscode from 'vscode';
import { alignmentKey, computeAlignment } from '../git/alignment';
import { summarizeBranches, sumCounters } from '../git/branchSummary';
import type { RepoManager } from '../git/RepoManager';

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
    this.item.name = 'MultiGit: rama';
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
    this.project.text = `$(root-folder) ${projectName}`;
    this.project.tooltip = `${projectName} — ${repos.length} repositorios\nClic: abrir proyecto reciente`;
    this.project.show();

    const { ahead, behind, dirtyRepos } = sumCounters(repos.map((r) => r.status));
    const counters = [ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(' ');
    // Desalineados: la rama de la mayoría con un aviso (⚠N repos en otra rama).
    const alignment = computeAlignment(repos);
    const label = alignment
      ? `${alignment.target} $(warning)${alignment.outliers.length}`
      : summary.kind === 'single'
        ? summary.branch
        : `${summary.byBranch.length} ramas`;
    this.item.text = `$(git-branch) ${label}${counters ? ` ${counters}` : ''}`;
    this.notifyMisalignment(alignment);

    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**MultiGit** — ${repos.length} repositorios\n\n`);
    if (summary.kind === 'single') {
      md.appendMarkdown(`Todos en \`${summary.branch}\`\n\n`);
    } else {
      for (const group of summary.byBranch) {
        md.appendMarkdown(`$(git-branch) \`${group.branch}\`: ${group.repos.join(', ')}\n\n`);
      }
    }
    if (alignment) {
      md.appendMarkdown(
        `$(warning) ${alignment.outliers.length} repo(s) fuera de \`${alignment.target}\`: ${alignment.outliers.map((o) => o.repo).join(', ')}\n\n`,
      );
    }
    if (ahead || behind) md.appendMarkdown(`↑${ahead} por subir · ↓${behind} por bajar\n\n`);
    if (dirtyRepos) md.appendMarkdown(`${dirtyRepos} repo(s) con cambios sin commit\n\n`);
    md.appendMarkdown('_Clic para ver las ramas_');
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
    const ALIGN = `Alinear con '${alignment.target}'`;
    const NEVER = 'No avisar más';
    void vscode.window
      .showWarningMessage(
        `MultiGit: ${alignment.outliers.map((o) => `${o.repo} está en '${o.branch}'`).join(', ')}; el resto en '${alignment.target}'.`,
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
