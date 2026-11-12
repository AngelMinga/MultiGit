// Vista "Changes" con checkboxes, como la ventana Commit de IntelliJ.
// "Agrupar por" tiene dos opciones independientes (como IntelliJ):
//   Repositorio ✓, Directorio ✗ → Changes → mfcomponents (⎇ rama) → archivo  apps/mfcomponents/src/hooks
//   Repositorio ✓, Directorio ✓ → Changes → mfcomponents → src/hooks → archivo
//   Repositorio ✗, Directorio ✓ → Changes → apps/mfcomponents/src/hooks → archivo  mfcomponents
//   ninguna                     → Changes → archivo  apps/mfcomponents/src/hooks
// Los cambios versionados empiezan marcados y los sin versionar desmarcados.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commonAncestor } from '../git/branches';
import { STATUS_LABEL, type StatusFile } from '../git/changes';
import { describeHead } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';

export interface ChangesGrouping {
  repo: boolean;
  directory: boolean;
}

const GROUPING_KEY = 'multigit.changesGrouping';
type Section = 'changes' | 'unversioned';

export interface FileRef {
  repo: Repo;
  file: StatusFile;
}

export type ChangeNode =
  | { kind: 'section'; section: Section; files: FileRef[] }
  | { kind: 'repo'; section: Section; repo: Repo; files: FileRef[] }
  | { kind: 'dir'; section: Section; id: string; label: string; files: FileRef[] }
  | { kind: 'file'; section: Section; ref: FileRef };

const keyOf = (ref: FileRef) => `${ref.repo.root}\0${ref.file.path}`;

export class ChangesTree implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly checkedEmitter = new vscode.EventEmitter<void>();
  /** Cambió la selección de archivos marcados o la lista de archivos. */
  readonly onDidChangeChecked = this.checkedEmitter.event;

  private files: FileRef[] = [];
  /** Marcas explícitas del usuario; sin entrada = valor por defecto de su sección. */
  private readonly overrides = new Map<string, boolean>();
  private grouping: ChangesGrouping;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly manager: RepoManager,
    private readonly memento: vscode.Memento,
  ) {
    this.grouping = memento.get<ChangesGrouping>(GROUPING_KEY) ?? { repo: true, directory: false };
    this.publishGrouping();
  }

  // ------------------------------------------------------------------ datos

  /** Vuelve a leer los cambios de todos los repos. */
  refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const lists = await Promise.all(
          this.manager.all.map(async (repo) => {
            try {
              return (await repo.git.getChanges()).map((file) => ({ repo, file }));
            } catch {
              return [];
            }
          }),
        );
        this.files = lists.flat();
        // Olvida las marcas de archivos que ya no tienen cambios.
        const alive = new Set(this.files.map(keyOf));
        for (const k of this.overrides.keys()) if (!alive.has(k)) this.overrides.delete(k);
      } finally {
        this.loading = undefined;
      }
      this.changeEmitter.fire(undefined);
      this.checkedEmitter.fire();
    })();
    return this.loading;
  }

  isChecked(ref: FileRef): boolean {
    return this.overrides.get(keyOf(ref)) ?? ref.file.kind === 'tracked';
  }

  /** Archivos marcados (de todas las secciones). */
  get checkedFiles(): FileRef[] {
    return this.files.filter((f) => this.isChecked(f));
  }

  /** Todos los archivos versionados con cambios (para Rollback). */
  get trackedFiles(): FileRef[] {
    return this.files.filter((f) => f.file.kind === 'tracked');
  }

  setChecked(refs: readonly FileRef[], checked: boolean): void {
    for (const ref of refs) this.overrides.set(keyOf(ref), checked);
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Deja marcados solo `refs` (Commit File/Directory…). */
  setOnlyChecked(refs: readonly FileRef[]): void {
    const keep = new Set(refs.map(keyOf));
    for (const f of this.files) this.overrides.set(keyOf(f), keep.has(keyOf(f)));
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Para `onDidChangeCheckboxState` (con `manageCheckboxStateManually`). */
  onCheckboxChange(event: vscode.TreeCheckboxChangeEvent<ChangeNode>): void {
    for (const [node, state] of event.items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      for (const ref of filesOf(node)) this.overrides.set(keyOf(ref), checked);
    }
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Activa o desactiva una de las opciones de "Agrupar por". */
  toggleGrouping(option: keyof ChangesGrouping): void {
    this.grouping = { ...this.grouping, [option]: !this.grouping[option] };
    void this.memento.update(GROUPING_KEY, this.grouping);
    this.publishGrouping();
    this.changeEmitter.fire(undefined);
  }

  private publishGrouping(): void {
    void vscode.commands.executeCommand('setContext', 'multigit.changesGroupByRepo', this.grouping.repo);
    void vscode.commands.executeCommand('setContext', 'multigit.changesGroupByDir', this.grouping.directory);
  }

  private get modeId(): string {
    return `${this.grouping.repo ? 'r' : ''}${this.grouping.directory ? 'd' : ''}`;
  }

  // ------------------------------------------------------------------ árbol

  async getChildren(node?: ChangeNode): Promise<ChangeNode[]> {
    if (!node) {
      if (this.loading) await this.loading;
      const changes = this.files.filter((f) => f.file.kind !== 'untracked');
      const unversioned = this.files.filter((f) => f.file.kind === 'untracked');
      const sections: ChangeNode[] = [{ kind: 'section', section: 'changes', files: changes }];
      if (unversioned.length) sections.push({ kind: 'section', section: 'unversioned', files: unversioned });
      return sections;
    }

    switch (node.kind) {
      case 'section':
        if (this.grouping.repo) {
          return this.manager.all
            .map((repo) => ({ kind: 'repo' as const, section: node.section, repo, files: node.files.filter((f) => f.repo === repo) }))
            .filter((n) => n.files.length > 0);
        }
        if (this.grouping.directory) {
          return this.dirNodes(node.section, node.files, (ref) => this.relativeToWorkspace(ref), 'ws');
        }
        return this.flatFiles(node.section, node.files);
      case 'repo':
        if (this.grouping.directory) {
          return this.dirNodes(node.section, node.files, (ref) => path.posix.dirname(ref.file.path), node.repo.root);
        }
        return this.flatFiles(node.section, node.files);
      case 'dir':
        return sortFiles(node.files).map((ref) => ({ kind: 'file', section: node.section, ref }));
      case 'file':
        return [];
    }
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const label = node.section === 'changes' ? 'Changes' : 'Unversioned Files';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section/${node.section}/${this.modeId}`;
        item.description = `${node.files.length} archivo(s)`;
        item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.section.${node.section}`;
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `repo/${node.section}/${node.repo.root}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        const head = node.repo.status ? `⎇ ${describeHead(node.repo.status)}` : '';
        item.description = `${head}  ${node.files.length}`;
        item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.repo.${node.section}`;
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = String(node.files.length);
        item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.dir.${node.section}`;
        return item;
      }
      case 'file': {
        const { repo, file } = node.ref;
        const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
        item.id = `file/${node.section}/${this.modeId}/${keyOf(node.ref)}`;
        // resourceUri: ícono del tema de archivos y color/letra de la extensión git integrada.
        item.resourceUri = vscode.Uri.file(path.join(repo.root, file.path));
        // Sin carpetas en el árbol, la ruta va en gris al lado (como IntelliJ); sin repos, el repo.
        const where = this.grouping.directory ? (this.grouping.repo ? '' : repo.name) : this.relativeToWorkspace(node.ref);
        const parts = [where, file.origPath ? `← ${file.origPath}` : ''];
        item.description = parts.filter(Boolean).join('  ');
        item.tooltip = `${STATUS_LABEL[file.status]}: ${repo.name}/${file.path}`;
        item.checkboxState = this.isChecked(node.ref)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = `multigit.changes.file.${file.kind}`;
        item.command = { command: 'multigit.changes.openDiff', title: 'Ver diff', arguments: [node] };
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }

  // ------------------------------------------------------------------ helpers

  private containerState(files: readonly FileRef[]): vscode.TreeItemCheckboxState {
    return files.length > 0 && files.every((f) => this.isChecked(f))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  /** Agrupa archivos por directorio; los de la raíz van sueltos. */
  private dirNodes(section: Section, files: FileRef[], dirOf: (ref: FileRef) => string, scope: string): ChangeNode[] {
    const byDir = new Map<string, FileRef[]>();
    for (const ref of files) {
      const dir = dirOf(ref);
      const list = byDir.get(dir) ?? [];
      list.push(ref);
      byDir.set(dir, list);
    }
    const nodes: ChangeNode[] = [];
    for (const [dir, list] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (dir === '.' || dir === '') {
        nodes.push(...sortFiles(list).map((ref) => ({ kind: 'file' as const, section, ref })));
      } else {
        nodes.push({ kind: 'dir', section, id: `dir/${section}/${this.modeId}/${scope}/${dir}`, label: dir, files: list });
      }
    }
    // Carpetas primero, luego archivos sueltos (como el explorador).
    return nodes.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file'));
  }

  /** Archivos sin carpetas, ordenados por ruta. */
  private flatFiles(section: Section, files: readonly FileRef[]): ChangeNode[] {
    return [...files]
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .map((ref) => ({ kind: 'file' as const, section, ref }));
  }

  private relativeToWorkspace(ref: FileRef): string {
    const roots = this.manager.all.map((r) => r.root);
    const base = roots.length === 1 ? path.dirname(roots[0]!) : commonAncestor(roots);
    const abs = path.join(ref.repo.root, ref.file.path);
    return path.relative(base, path.dirname(abs)).split(path.sep).join('/');
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.checkedEmitter.dispose();
  }
}

/** Archivos bajo un nodo. */
export function filesOf(node: ChangeNode): FileRef[] {
  return node.kind === 'file' ? [node.ref] : node.files;
}

function sortFiles(files: readonly FileRef[]): FileRef[] {
  return [...files].sort((a, b) => path.posix.basename(a.file.path).localeCompare(path.posix.basename(b.file.path)));
}
