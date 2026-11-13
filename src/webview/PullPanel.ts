// Diálogo "Pull" (webview), como el de IntelliJ: [repositorio ▾] git pull [remote ▾] [rama ▾] y el modo
// (Merge / Rebase / --ff-only). El pull en sí lo hace runPull (preflight, progreso y resumen).
import * as vscode from 'vscode';
import { summarizeBranches } from '../git/branchSummary';
import type { RepoBranches } from '../git/branches';
import { errorText } from '../git/MultiRepoRunner';
import { commonUpstream, remoteBranchChoices, remotesOf, type PullRepoInput } from '../git/pull';
import type { Repo, RepoManager } from '../git/RepoManager';
import { runPull } from '../views/pullDialog';
import type { PullScopeView, PullState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

const ALL = '*';

export class PullPanel implements vscode.Disposable {
  private static current: PullPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private state: PullState | undefined;
  private repos: readonly Repo[] = [];
  private data = new Map<Repo, RepoBranches>();

  static async open(extensionUri: vscode.Uri, manager: RepoManager, initialRepo?: Repo): Promise<void> {
    const repos = manager.all;
    if (repos.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: no repositories were found.'));
      return;
    }
    const entries = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: reading branches…') }, () =>
      Promise.all(repos.map(async (r) => [r, await r.git.getBranches()] as const)),
    );
    const panel = (PullPanel.current ??= new PullPanel(extensionUri, manager));
    panel.repos = repos;
    panel.data = new Map(entries);
    panel.state = { scopes: panel.buildScopes(), initialScope: initialRepo?.root ?? ALL, busy: false };
    const summary = summarizeBranches(initialRepo ? [initialRepo] : repos);
    panel.panel.title = summary.kind === 'single' ? t('Pull to {0}', summary.branch) : 'Pull';
    panel.panel.reveal();
    panel.post();
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.pull', 'Pull', vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'pull', 'Pull');
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /** "Todos" y cada repo, con sus remotes y las ramas de cada remote. */
  private buildScopes(): PullScopeView[] {
    const scope = (id: string, label: string, repos: readonly Repo[]): PullScopeView => {
      const inputs: PullRepoInput[] = repos.flatMap((r) => (this.data.get(r) ? [{ repo: r.name, branches: this.data.get(r)! }] : []));
      const summary = summarizeBranches(repos);
      return {
        id,
        label,
        total: inputs.length,
        branch: summary.kind === 'single' ? summary.branch : null,
        remotes: remotesOf(inputs).map((remote) => ({
          name: remote,
          common: commonUpstream(inputs, remote),
          branches: remoteBranchChoices(inputs, remote, this.manager.favoriteBranches).map((c) => ({
            name: c.name,
            exists: c.repos.length,
            upstream: c.upstreamFor.length,
          })),
        })),
      };
    };
    return [scope(ALL, t('All Repositories ({0})', this.repos.length), this.repos), ...this.repos.map((r) => scope(r.root, r.name, [r]))];
  }

  private post(): void {
    if (this.ready && this.state) void postToWebview(this.panel.webview, { type: 'pull/state', payload: this.state });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'pull' } });
          this.post();
          break;
        case 'pull/close':
          this.panel.dispose();
          break;
        case 'pull/run': {
          const { scopeId, remote, branch, mode } = message.payload;
          const repos = scopeId === ALL ? this.repos : this.repos.filter((r) => r.root === scopeId);
          if (repos.length === 0) return;
          // Se cierra como en IntelliJ: el progreso y el resumen van en las notificaciones.
          this.panel.dispose();
          await runPull(this.manager, repos, this.data, branch ? { kind: 'branch', remote, branch } : { kind: 'upstream' }, mode);
          break;
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (PullPanel.current === this) PullPanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
