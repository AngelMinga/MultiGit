// Diff de un archivo de Changes como el de IntelliJ (pestaña del editor): HEAD | versión actual lado a
// lado, una casilla por bloque para el commit parcial (la misma selección que "Select Changes"),
// "N differences, M included", ↑ ↓ entre bloques (F7), ← → entre archivos ("13/16 files"), » para
// revertir un bloque y doble clic para ir a la línea. La derecha no se edita aquí: "Open in Editor"
// abre el diff de VS Code.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { statusLabel } from '../git/changes';
import { GitContentProvider } from '../git/GitContentProvider';
import { allLineIds, diffFingerprint, parseHunks } from '../git/hunks';
import { errorText } from '../git/MultiRepoRunner';
import { type SideBlock, sideBlocks, wholeFileBlocks } from '../git/sideDiff';
import { type ChangesTree, type FileRef, keyOf } from '../views/ChangesTree';
import type { DiffState, WebviewMessage } from './protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

/** Por encima de este tamaño no se dibuja (se ofrece el diff de VS Code). */
const MAX_SIZE = 3_000_000;

type Loaded = Omit<DiffState, 'index' | 'count' | 'selected' | 'checked'> & { fingerprint: string; ids: string[] };

const isBinary = (text: string) => text.includes('\0');

/** Bloques y datos del archivo (sin la selección ni la posición). */
async function load(ref: FileRef): Promise<Loaded> {
  const { repo, file } = ref;
  const head = (await repo.git.headSha())?.slice(0, 8) ?? '';
  const base: Loaded = {
    repo: repo.name,
    colorIndex: repo.colorIndex,
    path: file.path,
    origPath: file.origPath,
    base: head,
    status: statusLabel(file.status),
    blocks: [],
    select: 'file',
    local: false,
    fingerprint: '',
    ids: [],
  };
  if (file.kind === 'conflict') return { ...base, notice: t('The file has conflicts; resolve them in the merge window.') };
  const disk = () => fs.readFile(path.join(repo.root, file.path), 'utf8').catch(() => '');
  const isNew = file.kind === 'untracked' || file.status === 'A' || file.status === 'C';
  if (isNew || file.status === 'D') {
    const oldText = isNew ? '' : await repo.git.showFile('HEAD', file.path).catch(() => '');
    const newText = file.status === 'D' ? '' : await disk();
    if (isBinary(oldText) || isBinary(newText)) return { ...base, base: isNew ? '' : head, notice: t('Binary files cannot be shown here.') };
    if (oldText.length + newText.length > MAX_SIZE) return { ...base, notice: t('The file is too large to show here.') };
    return { ...base, base: isNew ? '' : head, blocks: wholeFileBlocks(oldText, newText), local: file.status !== 'D' };
  }
  const renamed = file.status === 'R' && file.origPath;
  const diff = renamed ? await repo.git.diffRenamed(file.origPath!, file.path) : await repo.git.diffForPartial(file.path);
  const hunks = parseHunks(diff);
  if (!hunks) return { ...base, notice: t('Binary files cannot be shown here.') };
  const oldText = await repo.git.showFile('HEAD', renamed ? file.origPath! : file.path).catch(() => '');
  if (oldText.length > MAX_SIZE) return { ...base, notice: t('The file is too large to show here.') };
  // Commit parcial: solo modificados en UTF-8 (como "Select Changes").
  const partial = file.status === 'M' && !diff.includes('�') && !oldText.includes('�');
  const blocks: SideBlock[] = sideBlocks(oldText, hunks).map((b) => (b.type === 'change' && !partial ? { ...b, ids: [] } : b));
  return {
    ...base,
    blocks,
    select: partial ? 'lines' : 'file',
    local: true,
    fingerprint: partial ? diffFingerprint(diff) : '',
    ids: partial ? allLineIds(hunks) : [],
    notice: hunks.length === 0 ? t('The file has no changes against HEAD.') : undefined,
  };
}

const stripEol = (line: string) => line.replace(/\r?\n$/, '');

export class DiffPanel implements vscode.Disposable {
  private static current: DiffPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private ref!: FileRef;
  private loaded: Loaded | undefined;
  private state: DiffState | undefined;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;

  /** Abre (o reutiliza) la pestaña del diff con el archivo. */
  static async open(extensionUri: vscode.Uri, tree: ChangesTree, ref: FileRef, openNative: (ref: FileRef) => Promise<void>): Promise<void> {
    const panel = (DiffPanel.current ??= new DiffPanel(extensionUri, tree, openNative));
    await panel.show(ref);
    panel.panel.reveal(undefined, false);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly tree: ChangesTree,
    private readonly openNative: (ref: FileRef) => Promise<void>,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.diff', t('Diff'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit-commit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'diff', t('Diff'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
      // Cambió la lista de archivos o las casillas (también desde la vista Changes): se recarga.
      tree.onDidChangeChecked(() => this.scheduleReload()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.ref && doc.uri.fsPath === path.join(this.ref.repo.root, this.ref.file.path)) this.scheduleReload();
      }),
    );
  }

  /** Muestra otro archivo. */
  private async show(ref: FileRef): Promise<void> {
    this.ref = ref;
    this.panel.title = t('Commit: {0}', path.posix.basename(ref.file.path));
    await this.reload(true);
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(false), 150);
  }

  /** Vuelve a leer el archivo y la selección. `fresh`: otro archivo (no avisar de cambios). */
  private async reload(fresh: boolean): Promise<void> {
    const seq = ++this.seq;
    const files = await this.tree.orderedFiles();
    const key = keyOf(this.ref);
    const now = files.find((f) => keyOf(f) === key);
    let loaded: Loaded;
    if (now) {
      this.ref = now;
      loaded = await load(now).catch((error: unknown) => ({ ...this.emptyLoaded(), notice: errorText(error) }));
    } else {
      loaded = { ...this.emptyLoaded(), notice: t('The file has no local changes.') };
    }
    if (seq !== this.seq || this.disposed) return;
    this.loaded = loaded;
    const saved = now ? this.tree.partialOf(now) : undefined;
    const checked = now ? this.tree.isChecked(now) : false;
    const valid = !!saved && saved.fingerprint === loaded.fingerprint;
    this.state = {
      ...loaded,
      selected: loaded.select === 'lines' ? (valid ? saved.selected : checked ? loaded.ids : []) : [],
      checked,
      index: now ? files.findIndex((f) => keyOf(f) === key) : -1,
      count: files.length,
      notice: loaded.notice ?? (!fresh && saved && !valid ? t('The file changed since the lines were selected; review the selection.') : undefined),
    };
    this.post();
  }

  private emptyLoaded(): Loaded {
    const { repo, file } = this.ref;
    return { repo: repo.name, colorIndex: repo.colorIndex, path: file.path, base: '', status: statusLabel(file.status), blocks: [], select: 'file', local: false, fingerprint: '', ids: [] };
  }

  private post(): void {
    if (this.ready && this.state) void postToWebview(this.panel.webview, { type: 'diff/state', payload: this.state });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'diff' } });
          this.post();
          break;
        case 'diff/select': {
          const loaded = this.loaded;
          if (!loaded || loaded.select !== 'lines') return;
          // Si el archivo cambió desde que se dibujó, se recarga en vez de guardar una selección vieja.
          const fresh = await load(this.ref);
          if (fresh.fingerprint !== loaded.fingerprint) {
            await this.reload(false);
            return;
          }
          const known = new Set(loaded.ids);
          const selected = message.payload.selected.filter((id) => known.has(id));
          this.tree.setPartial(this.ref, { fingerprint: loaded.fingerprint, selected, total: loaded.ids.length });
          break;
        }
        case 'diff/check':
          this.tree.setChecked([this.ref], message.payload.checked);
          break;
        case 'diff/file': {
          const files = await this.tree.orderedFiles();
          const at = files.findIndex((f) => keyOf(f) === keyOf(this.ref));
          const next = files[at + message.payload.delta];
          if (next) await this.show(next);
          break;
        }
        case 'diff/openEditor':
          await this.openNative(this.ref);
          break;
        case 'diff/revert':
          await this.revert(message.payload.block);
          break;
        case 'diff/goto':
          await this.goto(message.payload.side, message.payload.line);
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  /** » de IntelliJ: el bloque vuelve a como está en HEAD (en el editor, con deshacer, y se guarda). */
  private async revert(index: number): Promise<void> {
    const block = this.state?.blocks[index];
    if (!block || block.type !== 'change' || !this.state?.local) return;
    const uri = vscode.Uri.file(path.join(this.ref.repo.root, this.ref.file.path));
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = block.newIndex;
    const same = block.new.every((line, k) => start + k < doc.lineCount && doc.lineAt(start + k).text === stripEol(line));
    if (!same) throw new Error(t('The file changed; save it and try again.'));
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const text = block.old.map((l) => stripEol(l) + eol).join('');
    const edit = new vscode.WorkspaceEdit();
    const end = start + block.new.length;
    if (block.new.length) {
      const to = end < doc.lineCount ? new vscode.Position(end, 0) : doc.lineAt(doc.lineCount - 1).rangeIncludingLineBreak.end;
      edit.replace(uri, new vscode.Range(new vscode.Position(start, 0), to), text);
    } else if (start < doc.lineCount) {
      edit.insert(uri, new vscode.Position(start, 0), text);
    } else {
      edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, eol + text.slice(0, -eol.length));
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(t('The change could not be reverted.'));
    await doc.save();
    await this.tree.refresh();
  }

  /** Doble clic: abre el archivo (o la versión de HEAD) en esa línea (desde 0). */
  private async goto(side: 'old' | 'new', line: number): Promise<void> {
    const { repo, file } = this.ref;
    const uri =
      side === 'new' && this.state?.local
        ? vscode.Uri.file(path.join(repo.root, file.path))
        : GitContentProvider.uri(repo.root, 'HEAD', file.origPath ?? file.path);
    const pos = new vscode.Position(Math.max(0, line), 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (DiffPanel.current === this) DiffPanel.current = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
