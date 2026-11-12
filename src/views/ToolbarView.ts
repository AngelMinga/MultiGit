// Vista "Proyecto": barra con los dos botones de IntelliJ, `[B] proyecto ▾` y `⎇ rama ▾`,
// y una línea de resumen. Es un WebviewView porque las vistas nativas no admiten botones con texto.
import * as vscode from 'vscode';
import { summarizeBranches, sumCounters } from '../git/branchSummary';
import { preferredColorIndex } from '../git/repoColor';
import type { RepoManager } from '../git/RepoManager';
import type { ToolbarState, WebviewMessage } from '../webview/protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from '../webview/webviewHtml';
import { t } from '../i18n';

const COMMANDS = {
  project: 'workbench.action.openRecent',
  branches: 'multigit.branches',
  log: 'multigit.openGitLog',
  changes: 'multigit.changes.focus',
} as const;

export class ToolbarView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'multigit.toolbar';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
  ) {
    this.disposables.push(manager.onDidChange(() => this.postState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'toolbar', 'Proyecto');
    this.disposables.push(
      onWebviewMessage(view.webview, (m) => this.onMessage(m)),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  private onMessage(message: WebviewMessage): void {
    if (message.type === 'ready') {
      this.ready = true;
      void this.view?.webview.postMessage({ type: 'init', payload: { kind: 'toolbar' } });
      this.postState();
    } else if (message.type === 'toolbar/action') {
      void vscode.commands.executeCommand(COMMANDS[message.payload.action]);
    }
  }

  private postState(): void {
    if (!this.view || !this.ready) return;
    const repos = this.manager.all;
    const summary = summarizeBranches(repos);
    const { ahead, behind } = sumCounters(repos.map((r) => r.status));
    const project = vscode.workspace.name?.replace(/ \(Workspace\)$/, '') ?? 'MultiGit';
    const state: ToolbarState = {
      project,
      projectColor: preferredColorIndex(project),
      branch:
        summary.kind === 'single' ? summary.branch : summary.kind === 'mixed' ? t('{0} branches', summary.byBranch.length) : t('no repos'),
      mixed: summary.kind === 'mixed',
      repos: repos.length,
      ahead,
      behind,
      changes: repos.reduce((n, r) => n + (r.status?.changes.total ?? 0), 0),
    };
    void postToWebview(this.view.webview, { type: 'toolbar/state', payload: state });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
