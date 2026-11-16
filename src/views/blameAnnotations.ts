// Annotate with Git Blame (como IntelliJ): a la izquierda de cada línea, fecha y autor del último cambio,
// con el fondo más intenso cuanto más reciente. Al pasar el ratón: el commit, y enlaces a Show in Git Log,
// Show Diff, Annotate Previous Revision y Copy hash. Se actualiza al editar (blame del texto sin guardar).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ageLevels, parseBlame, shortAuthor, UNCOMMITTED, type BlameLine } from '../git/blame';
import { GitContentProvider, openCommitFileDiff } from '../git/GitContentProvider';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import { t } from '../i18n';

/** Archivo anotado: su repo, ruta y revisión (sin revisión = working tree). */
interface Source {
  repo: Repo;
  rel: string;
  rev?: string;
}

interface Annotated {
  source: Source;
  lines: BlameLine[];
}

const LEVELS = 5;
const CONTEXT_KEY = 'multigit.blameActive';
/** Más reciente = fondo más intenso (como IntelliJ). */
const ALPHA = [0.34, 0.26, 0.18, 0.11, 0.05];

export class BlameAnnotations implements vscode.Disposable {
  private readonly annotated = new Map<string, Annotated>();
  private readonly types: vscode.TextEditorDecorationType[];
  private readonly uncommittedType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly manager: RepoManager,
    private readonly showInLog: (repo: Repo, hash: string) => Promise<void>,
  ) {
    const base = { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 1.2em 0 0', fontStyle: 'normal' } as const;
    this.types = ALPHA.map((a) => vscode.window.createTextEditorDecorationType({ before: { ...base, backgroundColor: `rgba(217, 119, 87, ${a})` } }));
    this.uncommittedType = vscode.window.createTextEditorDecorationType({
      before: { ...base, backgroundColor: new vscode.ThemeColor('editorGutter.addedBackground'), fontStyle: 'italic' },
    });
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.annotated.delete(doc.uri.toString())),
      vscode.commands.registerCommand('multigit.blame.showInLog', (root: string, hash: string) => {
        const repo = this.repoOf(root);
        return repo ? this.showInLog(repo, hash) : undefined;
      }),
      vscode.commands.registerCommand('multigit.blame.showDiff', (root: string, hash: string, file: string, previous?: string) =>
        openCommitFileDiff(root, hash, { status: previous && previous !== file ? 'R' : 'M', path: file, ...(previous && previous !== file ? { oldPath: previous } : {}) }),
      ),
      vscode.commands.registerCommand('multigit.blame.annotatePrevious', (root: string, hash: string, file: string) => this.annotatePrevious(root, hash, file)),
      vscode.commands.registerCommand('multigit.blame.copyHash', async (hash: string) => {
        await vscode.env.clipboard.writeText(hash);
        vscode.window.setStatusBarMessage(`$(copy) ${hash.slice(0, 7)}`, 3000);
      }),
      vscode.commands.registerCommand('multigit.blame.close', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) this.close(editor.document);
      }),
    );
  }

  /** Líneas anotadas de un documento (o undefined si no está anotado). */
  linesOf(uri: vscode.Uri): readonly BlameLine[] | undefined {
    return this.annotated.get(uri.toString())?.lines;
  }

  /** Annotate / Close Annotations en el editor del archivo. */
  async toggle(editor: vscode.TextEditor): Promise<void> {
    const key = editor.document.uri.toString();
    if (this.annotated.has(key)) return this.close(editor.document);
    const source = this.sourceOf(editor.document.uri);
    if (!source) {
      void vscode.window.showWarningMessage(t('MultiGit: the file is not in any detected repository.'));
      return;
    }
    await this.annotate(editor.document, source);
  }

  private async annotate(doc: vscode.TextDocument, source: Source): Promise<void> {
    try {
      const output = await source.repo.git.blame(source.rel, source.rev ? { rev: source.rev } : { contents: doc.getText() });
      this.annotated.set(doc.uri.toString(), { source, lines: parseBlame(output) });
      this.renderAll();
      this.updateContext();
    } catch (error) {
      const text = errorText(error);
      void vscode.window.showWarningMessage(
        /no such path|no such file|not in the working tree|fatal: no such ref/i.test(text)
          ? t('MultiGit: {0} is not in Git yet: there is nothing to annotate.', path.posix.basename(source.rel))
          : t('MultiGit: could not annotate {0}: {1}', path.posix.basename(source.rel), text),
      );
    }
  }

  private close(doc: vscode.TextDocument): void {
    this.annotated.delete(doc.uri.toString());
    for (const editor of vscode.window.visibleTextEditors.filter((e) => e.document === doc)) {
      for (const type of [...this.types, this.uncommittedType]) editor.setDecorations(type, []);
    }
    this.updateContext();
  }

  /** Annotate Previous Revision: abre el archivo en el commit anterior a ese cambio, ya anotado. */
  private async annotatePrevious(root: string, hash: string, file: string): Promise<void> {
    const repo = this.repoOf(root);
    if (!repo) return;
    const uri = GitContentProvider.uri(root, hash, file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    await this.annotate(doc, { repo, rel: file, rev: hash });
  }

  /** Al editar, se vuelve a anotar (con el texto sin guardar) tras una pausa. */
  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const current = this.annotated.get(key);
    if (!current || current.source.rev) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.annotated.has(key)) void this.annotate(doc, current.source);
      }, 600),
    );
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const data = this.annotated.get(editor.document.uri.toString());
      if (data) this.render(editor, data);
    }
  }

  private render(editor: vscode.TextEditor, { source, lines }: Annotated): void {
    const levels = ageLevels(lines, LEVELS);
    const dateFormat = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'short' });
    const labels = lines.map((l) => (l.hash === UNCOMMITTED ? t('Not Committed Yet') : `${dateFormat.format(new Date(l.time))} ${shortAuthor(l.author)}`));
    const width = Math.max(...labels.map((s) => s.length), 10);
    const byType = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    for (const type of [...this.types, this.uncommittedType]) byType.set(type, []);
    const count = Math.min(lines.length, editor.document.lineCount);
    for (let i = 0; i < count; i++) {
      const line = lines[i]!;
      const type = line.hash === UNCOMMITTED ? this.uncommittedType : this.types[levels.get(line.hash) ?? LEVELS - 1]!;
      // Como IntelliJ, el texto solo en la primera línea de cada bloque del mismo commit.
      const first = i === 0 || lines[i - 1]!.hash !== line.hash;
      byType.get(type)!.push({
        range: new vscode.Range(i, 0, i, 0),
        hoverMessage: this.hover(source, line),
        renderOptions: { before: { contentText: (first ? labels[i]! : '').padEnd(width, ' ').replace(/ /g, '\u00a0'), width: `${width + 1}ch` } },
      });
    }
    for (const [type, options] of byType) editor.setDecorations(type, options);
  }

  private hover(source: Source, line: BlameLine): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    if (line.hash === UNCOMMITTED) {
      md.appendMarkdown(`**${t('Not Committed Yet')}**`);
      return md;
    }
    const link = (label: string, command: string, args: unknown[]) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
    const root = source.repo.root;
    const date = new Date(line.time).toLocaleString(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' });
    md.appendMarkdown(`$(git-commit) \`${line.hash.slice(0, 7)}\` · **${escape(line.author)}** · ${date}\n\n`);
    md.appendText(`${line.summary}\n\n`);
    const actions = [
      link(t('Show in Git Log'), 'multigit.blame.showInLog', [root, line.hash]),
      link(t('Show Diff'), 'multigit.blame.showDiff', [root, line.hash, line.path, line.previous?.path]),
      ...(line.previous ? [link(t('Annotate Previous Revision'), 'multigit.blame.annotatePrevious', [root, line.previous.hash, line.previous.path])] : []),
      link(t('Copy hash'), 'multigit.blame.copyHash', [line.hash]),
    ];
    md.appendMarkdown(actions.join(' · '));
    return md;
  }

  private sourceOf(uri: vscode.Uri): Source | undefined {
    const git = GitContentProvider.parse(uri);
    if (git) {
      const repo = this.repoOf(git.root);
      return repo && git.ref ? { repo, rel: git.path, rev: git.ref } : undefined;
    }
    if (uri.scheme !== 'file') return undefined;
    const repo = this.manager.allRepos
      .filter((r) => {
        const rel = path.relative(r.root, uri.fsPath);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      })
      .sort((a, b) => b.root.length - a.root.length)[0];
    return repo ? { repo, rel: path.relative(repo.root, uri.fsPath).split(path.sep).join('/') } : undefined;
  }

  private repoOf(root: string): Repo | undefined {
    return this.manager.allRepos.find((r) => r.root === root);
  }

  private updateContext(): void {
    const doc = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!doc && this.annotated.has(doc.uri.toString()));
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of [...this.disposables, ...this.types, this.uncommittedType]) d.dispose();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
