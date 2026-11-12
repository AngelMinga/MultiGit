// Caja de commit (WebviewView debajo de Changes): mensaje, Amend, Commit y Commit and Push….
import * as vscode from 'vscode';
import type { Repo, RepoManager } from '../git/RepoManager';
import { describeCounts } from '../git/changes';
import type { CommitState, WebviewMessage } from '../webview/protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from '../webview/webviewHtml';
import type { ChangesActions } from './changesActions';
import type { ChangesTree } from './ChangesTree';

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'multigit.commit';

  private view: vscode.WebviewView | undefined;
  private busy = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly tree: ChangesTree,
    private readonly actions: ChangesActions,
    private readonly openPush: (repos: readonly Repo[]) => Promise<void>,
  ) {
    this.disposables.push(tree.onDidChangeChecked(() => this.postState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'commit', 'Commit');
    this.disposables.push(
      onWebviewMessage(view.webview, (m) => void this.onMessage(m)),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
  }

  /** Enfoca la caja de commit (comando "Commit…"). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CommitView.viewId}.focus`);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.view) void postToWebview(this.view.webview, { type: 'init', payload: { kind: 'commit' } });
        this.postState();
        break;
      case 'commit/requestLastMessage': {
        const last = await this.actions.lastMessage();
        if (this.view) void postToWebview(this.view.webview, { type: 'commit/setMessage', payload: { message: last } });
        break;
      }
      case 'commit/run': {
        if (this.busy) return;
        this.busy = true;
        this.postState();
        try {
          const { message: text, amend, push } = message.payload;
          const repos = await this.actions.commit(text, amend);
          if (repos && repos.length > 0) {
            if (this.view) void postToWebview(this.view.webview, { type: 'commit/done', payload: {} });
            if (push) await this.openPush(repos);
          }
        } finally {
          this.busy = false;
          this.postState();
        }
        break;
      }
      default:
        break;
    }
  }

  private postState(): void {
    if (!this.view) return;
    const checked = this.tree.checkedFiles;
    const repos = this.manager.all
      .map((r) => ({ name: r.name, colorIndex: r.colorIndex, count: checked.filter((c) => c.repo === r).length }))
      .filter((r) => r.count > 0);
    const state: CommitState = { repos, total: checked.length, summary: describeCounts(checked.map((c) => c.file)), busy: this.busy };
    void postToWebview(this.view.webview, { type: 'commit/state', payload: state });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
