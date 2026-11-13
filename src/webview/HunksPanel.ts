// Diálogo "Select Changes to Commit" (webview): el diff de un archivo con casillas por hunk y por
// línea, como las del diff del commit de IntelliJ. Guarda la selección en ChangesTree; el commit
// parcial lo hace ChangesActions.commit.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { allLineIds, diffFingerprint, hunkRows, parseHunks } from '../git/hunks';
import { errorText } from '../git/MultiRepoRunner';
import type { ChangesTree, FileRef } from '../views/ChangesTree';
import type { HunksState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

/** Diff del archivo listo para elegir líneas, o el motivo por el que no se puede. */
async function load(ref: FileRef): Promise<{ fingerprint: string; ids: string[]; hunks: HunksState['hunks'] } | { error: string }> {
  const { repo, file } = ref;
  if (file.kind !== 'tracked' || file.status !== 'M') {
    return { error: t('Only modified files can be committed partially; this one is {0}.', file.kind === 'untracked' ? t('untracked') : file.status) };
  }
  const diff = await repo.git.diffForPartial(file.path);
  const hunks = parseHunks(diff);
  if (!hunks) return { error: t('Binary files cannot be committed partially.') };
  if (hunks.length === 0) return { error: t('The file has no changes against HEAD.') };
  const oldText = await repo.git.showFile('HEAD', file.path);
  if (diff.includes('�') || oldText.includes('�')) return { error: t('Only UTF-8 text files can be committed partially.') };
  return { fingerprint: diffFingerprint(diff), ids: allLineIds(hunks), hunks: hunkRows(oldText, hunks) };
}

export class HunksPanel implements vscode.Disposable {
  private static current: HunksPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private state: HunksState | undefined;
  private fingerprint = '';
  private total = 0;

  /** Abre el diálogo para un archivo (o lo reutiliza). */
  static async open(extensionUri: vscode.Uri, tree: ChangesTree, ref: FileRef, openDiff: (ref: FileRef) => Promise<void>): Promise<void> {
    const loaded = await load(ref);
    if ('error' in loaded) {
      void vscode.window.showWarningMessage(`MultiGit: ${loaded.error}`);
      return;
    }
    const panel = (HunksPanel.current ??= new HunksPanel(extensionUri, tree, openDiff));
    panel.ref = ref;
    panel.apply(loaded);
    panel.panel.title = t('Select Changes: {0}', path.posix.basename(ref.file.path));
    panel.panel.reveal();
  }

  private ref!: FileRef;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly tree: ChangesTree,
    private readonly openDiff: (ref: FileRef) => Promise<void>,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.hunks', t('Select Changes'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'hunks', t('Select Changes'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Muestra el diff cargado con la selección guardada (si sigue valiendo) o todo marcado. */
  private apply(loaded: { fingerprint: string; ids: string[]; hunks: HunksState['hunks'] }, notice?: string): void {
    const saved = this.tree.partialOf(this.ref);
    const valid = saved?.fingerprint === loaded.fingerprint;
    this.fingerprint = loaded.fingerprint;
    this.total = loaded.ids.length;
    const checked = this.tree.isChecked(this.ref);
    this.state = {
      repo: this.ref.repo.name,
      colorIndex: this.ref.repo.colorIndex,
      path: this.ref.file.path,
      hunks: loaded.hunks,
      selected: valid ? saved.selected : checked ? loaded.ids : [],
      notice: notice ?? (saved && !valid ? t('The file changed since the lines were selected; review the selection.') : undefined),
    };
    this.post();
  }

  private post(): void {
    if (this.ready && this.state) void postToWebview(this.panel.webview, { type: 'hunks/state', payload: this.state });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'hunks' } });
          this.post();
          break;
        case 'hunks/openDiff':
          await this.openDiff(this.ref);
          break;
        case 'hunks/save': {
          // Si el archivo cambió mientras el diálogo estaba abierto, se recarga en vez de guardar.
          const loaded = await load(this.ref);
          if ('error' in loaded) throw new Error(loaded.error);
          if (loaded.fingerprint !== this.fingerprint) {
            this.apply(loaded, t('The file changed while the dialog was open; review the selection and save again.'));
            return;
          }
          const known = new Set(loaded.ids);
          const selected = message.payload.selected.filter((id) => known.has(id));
          this.tree.setPartial(this.ref, { fingerprint: this.fingerprint, selected, total: this.total });
          this.panel.dispose();
          break;
        }
        case 'hunks/close':
          this.panel.dispose();
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (HunksPanel.current === this) HunksPanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
