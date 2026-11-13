// Diálogo "Interactively Rebase from Here" (webview), como el de IntelliJ: los commits desde el elegido
// hasta HEAD, con su acción (pick, reword, squash, fixup, drop) y el orden. El rebase lo hace git
// (`rebase -i` con nuestro todo); si hay conflictos queda a medias y se sigue desde la barra de operaciones.
import * as vscode from 'vscode';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import { isNoop, validatePlan, type RebaseEntry } from '../git/rebase';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { RebaseState, WebviewMessage } from './protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

export class RebasePanel implements vscode.Disposable {
  private static current: RebasePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private state!: RebaseState;
  private repo!: Repo;
  private base: string | null = null;
  /** HEAD al abrir: si cambia, el plan ya no vale. */
  private head = '';

  /**
   * Abre el diálogo para rebasear desde `hash` (incluido). Avisa y no abre si el commit no está en la
   * rama actual, si hay merges en el rango o si no hay commits.
   */
  static async open(extensionUri: vscode.Uri, manager: RepoManager, repo: Repo, hash: string, onDone: () => Promise<void>): Promise<void> {
    const git = repo.git;
    if (!(await git.isAncestor(hash, 'HEAD'))) {
      void vscode.window.showWarningMessage(t('MultiGit: {0} is not in the current branch of {1}.', hash.slice(0, 7), repo.name));
      return;
    }
    const { base, commits, merges } = await git.rebaseCommits(hash);
    if (merges > 0) {
      void vscode.window.showWarningMessage(t('MultiGit: there are merge commits between {0} and HEAD; interactive rebase does not support them.', hash.slice(0, 7)));
      return;
    }
    if (commits.length === 0) return;
    const panel = (RebasePanel.current ??= new RebasePanel(extensionUri, manager, onDone));
    panel.repo = repo;
    panel.base = base;
    panel.head = (await git.exec(['rev-parse', 'HEAD'])).trim();
    const status = await git.getStatus();
    panel.state = { repo: repo.name, colorIndex: repo.colorIndex, branch: status.branch ?? 'HEAD', commits, busy: false };
    panel.panel.title = t('Rebase {0}', repo.name);
    panel.panel.reveal();
    panel.post();
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly onDone: () => Promise<void>,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.rebase', t('Interactive Rebase'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'rebase', t('Interactive Rebase'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(): void {
    if (this.ready && this.state) void postToWebview(this.panel.webview, { type: 'rebase/state', payload: this.state });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'rebase' } });
          this.post();
          break;
        case 'rebase/close':
          this.panel.dispose();
          break;
        case 'rebase/start':
          await this.start(message.payload.entries);
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  private async start(entries: RebaseEntry[]): Promise<void> {
    const original = this.state.commits.map((c) => c.hash);
    if (isNoop(entries, original)) {
      this.panel.dispose();
      return;
    }
    const known = new Set(original);
    if (entries.length !== original.length || entries.some((e) => !known.has(e.hash))) throw new Error(t('The list of commits is not valid.'));
    const problem = validatePlan(entries);
    if (problem) {
      throw new Error(
        problem === 'first-squash'
          ? t('The first commit cannot be squash or fixup: there is no previous commit to join it to.')
          : problem === 'all-dropped'
            ? t('All commits are dropped; use Reset to move the branch instead.')
            : t('The new message of a reworded commit is empty.'),
      );
    }
    const head = (await this.repo.git.exec(['rev-parse', 'HEAD'])).trim();
    if (head !== this.head) throw new Error(t('The branch changed since the dialog was opened; open it again.'));

    this.state = { ...this.state, busy: true };
    this.post();
    let results;
    try {
      results = await runInRepos(this.manager, {
        title: t('Interactive rebase of {0} in {1}', this.state.branch, this.repo.name),
        repos: [this.repo],
        requireClean: true,
        run: async (repo) => {
          await repo.git.interactiveRebase(this.base, entries);
        },
      });
    } finally {
      this.state = { ...this.state, busy: false };
      this.post();
    }
    await this.onDone();
    // Hecho, o a medias por conflictos (se sigue desde la barra de operaciones): se cierra. Si falló por
    // otra cosa, queda abierto para corregir el plan.
    if (results?.[0]?.state === 'ok' || this.repo.operation) this.panel.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (RebasePanel.current === this) RebasePanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
