// Caja de commit (WebviewView debajo de Changes): mensaje, Amend, Commit y Commit and Push….
import * as vscode from 'vscode';
import type { Repo, RepoManager } from '../git/RepoManager';
import { describeCounts } from '../git/changes';
import {
  CancelledError,
  generateCommitMessage,
  NoChangesError,
  readClaudeSettings,
} from './claudeCommit';
import type { RepoSelection } from '../ai/multiRepoDiff';
import type { CommitState, WebviewMessage } from '../webview/protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from '../webview/webviewHtml';
import type { ChangesActions } from './changesActions';
import type { ChangesTree } from './ChangesTree';

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'multigit.commit';

  private view: vscode.WebviewView | undefined;
  private busy = false;
  /** Generación con Claude en curso (para cancelarla). */
  private generation: AbortController | undefined;
  /** Último mensaje que escribió Claude: si el usuario vuelve a pedir, se pide uno distinto. */
  private lastSuggestion: string | null = null;
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
      case 'commit/generate':
        await this.generate(message.payload.current);
        break;
      case 'commit/cancelGenerate':
        this.generation?.abort();
        break;
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

  /** Genera el mensaje con Claude a partir de los archivos marcados (de todos los repos). */
  private async generate(current: string): Promise<void> {
    if (this.generation) return;
    const checked = this.tree.checkedFiles;
    const repos: RepoSelection[] = this.manager.all
      .map((repo) => ({
        name: repo.name,
        root: repo.root,
        branch: repo.status?.branch ?? null,
        files: checked.filter((c) => c.repo === repo).map((c) => c.file),
      }))
      .filter((r) => r.files.length > 0);
    if (repos.length === 0) {
      void vscode.window.showWarningMessage('MultiGit: marca los archivos del commit en la vista Changes.');
      return;
    }

    const settings = readClaudeSettings();
    // Volver a pedir con el mensaje de Claude intacto = "dame otro" (se le pasa para que no lo repita).
    const isRetry = this.lastSuggestion !== null && current.trim() === this.lastSuggestion.trim();
    if (current.trim() && !isRetry && !settings.overwriteWithoutAsking) {
      const ok = await vscode.window.showWarningMessage(
        '¿Reemplazar el mensaje actual por uno generado por Claude?',
        { modal: true },
        'Reemplazar',
      );
      if (ok !== 'Reemplazar') return;
    }

    const controller = new AbortController();
    this.generation = controller;
    this.postState();
    const post = (msg: Parameters<typeof postToWebview>[1]) => this.view && void postToWebview(this.view.webview, msg);

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: '$(sparkle) Claude' },
        async (progress) => {
          const started = Date.now();
          let step = '';
          const show = () => progress.report({ message: `${step} ${Math.floor((Date.now() - started) / 1000)} s` });
          const ticker = setInterval(show, 1000);
          try {
            return await generateCommitMessage(settings, {
              repos,
              previousSuggestion: isRetry ? current : null,
              signal: controller.signal,
              onStep: (s) => {
                step = s;
                show();
              },
              onPartialMessage: (text) => post({ type: 'commit/partial', payload: { text } }),
            });
          } finally {
            clearInterval(ticker);
          }
        },
      );
      this.lastSuggestion = result.message;
      post({ type: 'commit/replaceMessage', payload: { message: result.message } });
      vscode.window.setStatusBarMessage(
        `$(sparkle) Tipo detectado: ${result.type}${result.reason ? ` — ${result.reason}` : ''}`,
        8000,
      );
    } catch (error) {
      post({ type: 'commit/replaceMessage', payload: { message: current } });
      if (error instanceof CancelledError) return;
      if (error instanceof NoChangesError) {
        void vscode.window.showWarningMessage('MultiGit: no hay cambios en los archivos marcados.');
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      const retry = await vscode.window.showErrorMessage(`MultiGit (Claude): ${text}`, 'Reintentar');
      if (retry) {
        this.generation = undefined;
        await this.generate(current);
      }
    } finally {
      if (this.generation === controller) this.generation = undefined;
      this.postState();
    }
  }

  private postState(): void {
    if (!this.view) return;
    const checked = this.tree.checkedFiles;
    const repos = this.manager.all
      .map((r) => ({ name: r.name, colorIndex: r.colorIndex, count: checked.filter((c) => c.repo === r).length }))
      .filter((r) => r.count > 0);
    const state: CommitState = {
      repos,
      total: checked.length,
      summary: describeCounts(checked.map((c) => c.file)),
      busy: this.busy,
      generating: this.generation !== undefined,
    };
    void postToWebview(this.view.webview, { type: 'commit/state', payload: state });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
