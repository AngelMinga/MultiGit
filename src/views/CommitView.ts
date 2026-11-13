// Caja de commit (WebviewView debajo de Changes): mensaje, Amend, Commit y Commit and Push….
import * as vscode from 'vscode';
import type { Repo, RepoManager } from '../git/RepoManager';
import { describeCounts } from '../git/changes';
import {
  addToHistory,
  applyTemplate,
  commonTicket,
  DEFAULT_TICKET_PATTERN,
  DEFAULT_TICKET_TEMPLATE,
  isOnlyPrefix,
  templatePrefix,
} from '../git/commitMessage';
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
import { t } from '../i18n';

const HISTORY_KEY = 'multigit.commitHistory';

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
    private readonly state: vscode.Memento,
  ) {
    this.disposables.push(
      tree.onDidChangeChecked(() => this.postState()),
      // La rama (y con ella el ticket) puede cambiar.
      manager.onDidChange(() => this.postState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('multigit.commit')) this.postState();
      }),
    );
  }

  private get history(): string[] {
    return this.state.get<string[]>(HISTORY_KEY) ?? [];
  }

  /** Ticket de la rama de los repos con archivos marcados (o de todos), si es el mismo en todos. */
  private ticket(): { ticket: string; branch: string; template: string } | undefined {
    const config = vscode.workspace.getConfiguration('multigit.commit');
    const pattern = config.get<string>('ticketPattern', DEFAULT_TICKET_PATTERN);
    const template = config.get<string>('ticketTemplate', DEFAULT_TICKET_TEMPLATE);
    if (!pattern.trim() || !template.trim()) return undefined;
    const checked = new Set(this.tree.checkedFiles.map((c) => c.repo));
    const repos = checked.size ? this.manager.all.filter((r) => checked.has(r)) : this.manager.all;
    const found = commonTicket(repos.map((r) => r.status?.branch), pattern);
    return found && { ...found, template };
  }

  private prefix(): string {
    const ticket = this.ticket();
    return ticket ? templatePrefix(ticket.template, ticket.ticket, ticket.branch) : '';
  }

  /** Comando Commit Message History…: la caja responde con su texto actual (commit/history). */
  async requestHistory(): Promise<void> {
    await this.focus();
    if (this.view) void postToWebview(this.view.webview, { type: 'commit/requestHistory', payload: {} });
    else await this.showHistory();
  }

  /** Commit Message History: mensajes usados en MultiGit y, debajo, tus últimos commits en los repos. */
  async showHistory(current = ''): Promise<void> {
    type Item = vscode.QuickPickItem & { message?: string };
    const toItem = (message: string, description?: string): Item => {
      const [subject = '', ...body] = message.split('\n');
      return { label: subject, description, detail: body.join(' ').trim() || undefined, message };
    };
    const used = this.history;
    const fromLog = new Map<string, string[]>();
    await Promise.all(
      this.manager.all.map(async (repo) => {
        const email = await repo.git.configGet('user.email');
        const messages = await repo.git.recentMessages(email, 15).catch(() => []);
        for (const m of messages) if (!used.includes(m)) fromLog.set(m, [...(fromLog.get(m) ?? []), repo.name]);
      }),
    );
    const items: Item[] = [
      ...(used.length ? [{ label: t('Recent messages'), kind: vscode.QuickPickItemKind.Separator }, ...used.map((m) => toItem(m))] : []),
      ...(fromLog.size
        ? [
            { label: t('Your recent commits'), kind: vscode.QuickPickItemKind.Separator },
            ...[...fromLog].map(([m, repos]) => toItem(m, repos.join(', '))),
          ]
        : []),
    ];
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no previous commit messages yet.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Commit Message History'),
      placeHolder: t('Choose a message to reuse'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked?.message) return;
    if (!isOnlyPrefix(current, this.prefix()) && current.trim() !== picked.message) {
      const REPLACE = t('Replace');
      const ok = await vscode.window.showWarningMessage(t('Replace the current message?'), { modal: true }, REPLACE);
      if (ok !== REPLACE) return;
    }
    await this.focus();
    if (this.view) void postToWebview(this.view.webview, { type: 'commit/replaceMessage', payload: { message: picked.message } });
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
      case 'commit/history':
        await this.showHistory(message.payload.current);
        break;
      case 'commit/run': {
        if (this.busy) return;
        this.busy = true;
        this.postState();
        try {
          const { message: text, amend, push } = message.payload;
          const repos = await this.actions.commit(text, amend);
          if (repos && repos.length > 0) {
            await this.state.update(HISTORY_KEY, addToHistory(this.history, text));
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
      void vscode.window.showWarningMessage(t('MultiGit: check the files to commit in the Changes view.'));
      return;
    }

    const settings = readClaudeSettings();
    // Volver a pedir con el mensaje de Claude intacto = "dame otro" (se le pasa para que no lo repita).
    const isRetry = this.lastSuggestion !== null && current.trim() === this.lastSuggestion.trim();
    if (!isOnlyPrefix(current, this.prefix()) && !isRetry && !settings.overwriteWithoutAsking) {
      const ok = await vscode.window.showWarningMessage(
        t('Replace the current message with one written by Claude?'),
        { modal: true },
        t('Replace'),
      );
      if (ok !== t('Replace')) return;
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
      const ticket = this.ticket();
      const message = ticket ? applyTemplate(result.message, ticket.template, ticket.ticket, ticket.branch) : result.message;
      this.lastSuggestion = message;
      post({ type: 'commit/replaceMessage', payload: { message } });
      const reason = result.reason ? ` — ${result.reason}` : '';
      vscode.window.setStatusBarMessage(
        t('$(sparkle) Detected type: {0}{1}', result.type, reason),
        8000,
      );
    } catch (error) {
      post({ type: 'commit/replaceMessage', payload: { message: current } });
      if (error instanceof CancelledError) return;
      if (error instanceof NoChangesError) {
        void vscode.window.showWarningMessage(t('MultiGit: the checked files have no changes.'));
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
    const partial = checked.filter((c) => this.tree.partialOf(c)).length;
    const state: CommitState = {
      repos,
      total: checked.length,
      summary: [describeCounts(checked.map((c) => c.file)), partial ? t('{0} partial', partial) : ''].filter(Boolean).join(' · '),
      busy: this.busy,
      generating: this.generation !== undefined,
      prefix: this.prefix(),
    };
    void postToWebview(this.view.webview, { type: 'commit/state', payload: state });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
