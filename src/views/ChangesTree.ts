// Vista "Changes" con checkboxes, como la ventana Commit de IntelliJ.
// "Group By" con tres niveles combinables, en este orden (como IntelliJ):
//   Repository → Module (carpeta con package.json, pubspec.yaml, build.gradle…) → Directory → archivo.
// Sin Directory, la ruta del archivo va en gris a su lado. "Show Ignored Files" agrega la sección
// Ignored Files. Los cambios versionados empiezan marcados y los sin versionar desmarcados.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commonAncestor } from '../git/branches';
import { statusLabel, type StatusFile } from '../git/changes';
import { describeHead } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';
import {
  DEFAULT_LIST,
  listOf,
  normalize,
  orderedLists,
  sync as syncLists,
  type ChangelistState,
} from '../git/changelists';
import { t } from '../i18n';

export interface ChangesGrouping {
  repo: boolean;
  module: boolean;
  directory: boolean;
  showIgnored: boolean;
}

const GROUPING_KEY = 'multigit.changesGrouping';
const DEFAULT_GROUPING: ChangesGrouping = { repo: true, module: false, directory: false, showIgnored: false };
type Section = 'changes' | 'unversioned' | 'ignored';
type Level = 'repo' | 'module' | 'dir';

/** Archivos que marcan la raíz de un módulo / paquete. */
const MODULE_MANIFESTS = [
  'package.json',
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'composer.json',
];

export interface FileRef {
  repo: Repo;
  file: StatusFile;
}

/** `list`: changelist del nodo (solo en la sección de cambios versionados). */
export type ChangeNode =
  | { kind: 'section'; section: Section; files: FileRef[]; list?: string }
  | { kind: 'repo'; section: Section; repo: Repo; files: FileRef[]; depth: number; list?: string }
  | { kind: 'module'; section: Section; id: string; label: string; files: FileRef[]; depth: number; moduleRel: string; list?: string }
  | { kind: 'dir'; section: Section; id: string; label: string; files: FileRef[]; list?: string }
  | { kind: 'file'; section: Section; ref: FileRef; list?: string };

export const keyOf = (ref: FileRef) => `${ref.repo.root}\0${ref.file.path}`;
const CHANGELISTS_KEY = 'multigit.changelists';
/** Parte de los ids de los nodos: la sección, y en Changes también la lista (puede haber el mismo repo en dos). */
const scopeOf = (section: Section, list?: string) => (list ? `${section}:${list}` : section);
/** ¿Va en una changelist? (los versionados con cambios y los conflictos; los sin versionar no). */
const inChangelists = (ref: FileRef) => ref.file.kind === 'tracked' || ref.file.kind === 'conflict';

/** Commit parcial de un archivo: qué líneas del diff entran (ver src/git/hunks.ts). */
export interface PartialSelection {
  /** Huella del diff cuando se eligieron; si el archivo cambia, la selección ya no vale. */
  fingerprint: string;
  selected: string[];
  total: number;
}

export class ChangesTree implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly checkedEmitter = new vscode.EventEmitter<void>();
  /** Cambió la selección de archivos marcados o la lista de archivos. */
  readonly onDidChangeChecked = this.checkedEmitter.event;

  private files: FileRef[] = [];
  /** Marcas explícitas del usuario; sin entrada = valor por defecto de su sección. */
  private readonly overrides = new Map<string, boolean>();
  /** Archivos con solo parte de sus líneas elegidas para el commit. */
  private readonly partial = new Map<string, PartialSelection>();
  private grouping: ChangesGrouping;
  private loading: Promise<void> | undefined;

  private lists: ChangelistState;

  constructor(
    private readonly manager: RepoManager,
    private readonly memento: vscode.Memento,
    /** Donde se guardan las changelists (por workspace). */
    private readonly workspaceMemento: vscode.Memento = memento,
  ) {
    this.grouping = { ...DEFAULT_GROUPING, ...memento.get<Partial<ChangesGrouping>>(GROUPING_KEY) };
    this.lists = normalize(workspaceMemento.get<Partial<ChangelistState>>(CHANGELISTS_KEY));
    this.publishGrouping();
    this.publishLists();
  }

  // ------------------------------------------------------------------ changelists

  get changelists(): ChangelistState {
    return this.lists;
  }

  /** Changelist de un archivo versionado. */
  listOfRef(ref: FileRef): string {
    return listOf(this.lists, keyOf(ref));
  }

  /** Archivos versionados con cambios de una lista. */
  filesInList(id: string): FileRef[] {
    return this.files.filter((f) => inChangelists(f) && this.listOfRef(f) === id);
  }

  /** Cambia las changelists, lo guarda y redibuja (`resetChecks`: esos archivos vuelven a su marca por defecto). */
  updateLists(next: ChangelistState, resetChecks: readonly FileRef[] = []): void {
    this.lists = next;
    void this.workspaceMemento.update(CHANGELISTS_KEY, next);
    for (const ref of resetChecks) {
      this.overrides.delete(keyOf(ref));
      this.partial.delete(keyOf(ref));
    }
    this.publishLists();
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  private publishLists(): void {
    void vscode.commands.executeCommand('setContext', 'multigit.changelistCount', this.lists.lists.length);
  }

  // ------------------------------------------------------------------ datos

  /** Vuelve a leer los cambios de todos los repos. */
  refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const lists = await Promise.all(
          this.manager.all.map(async (repo) => {
            try {
              return (await repo.git.getChanges(this.grouping.showIgnored)).map((file) => ({ repo, file }));
            } catch {
              return [];
            }
          }),
        );
        this.files = lists.flat();
        // Los archivos nuevos van a la changelist activa; se olvidan los que ya no tienen cambios.
        const synced = syncLists(this.lists, this.files.filter(inChangelists).map(keyOf));
        if (synced !== this.lists) {
          this.lists = synced;
          void this.workspaceMemento.update(CHANGELISTS_KEY, synced);
        }
        // Olvida las marcas de archivos que ya no tienen cambios.
        const alive = new Set(this.files.map(keyOf));
        for (const k of this.overrides.keys()) if (!alive.has(k)) this.overrides.delete(k);
        for (const k of this.partial.keys()) if (!alive.has(k)) this.partial.delete(k);
      } finally {
        this.loading = undefined;
      }
      this.changeEmitter.fire(undefined);
      this.checkedEmitter.fire();
    })();
    return this.loading;
  }

  isChecked(ref: FileRef): boolean {
    // Como IntelliJ: por defecto entran los cambios de la changelist activa.
    return this.overrides.get(keyOf(ref)) ?? (ref.file.kind === 'tracked' && this.listOfRef(ref) === this.lists.active);
  }

  /** Archivos marcados (de todas las secciones). */
  get checkedFiles(): FileRef[] {
    return this.files.filter((f) => this.isChecked(f));
  }

  /** Todos los archivos versionados con cambios (para Rollback). */
  get trackedFiles(): FileRef[] {
    return this.files.filter((f) => f.file.kind === 'tracked');
  }

  partialOf(ref: FileRef): PartialSelection | undefined {
    return this.partial.get(keyOf(ref));
  }

  /** Guarda las líneas elegidas de un archivo (todas → archivo completo; ninguna → desmarcado). */
  setPartial(ref: FileRef, selection: PartialSelection | undefined): void {
    const key = keyOf(ref);
    if (!selection || selection.selected.length === selection.total) this.partial.delete(key);
    else if (selection.selected.length === 0) this.partial.delete(key);
    else this.partial.set(key, selection);
    this.overrides.set(key, !selection || selection.selected.length > 0);
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Olvida las selecciones parciales (después de un commit). */
  clearPartial(refs: readonly FileRef[]): void {
    for (const ref of refs) this.partial.delete(keyOf(ref));
    this.changeEmitter.fire(undefined);
  }

  setChecked(refs: readonly FileRef[], checked: boolean): void {
    for (const ref of refs) {
      this.overrides.set(keyOf(ref), checked);
      this.partial.delete(keyOf(ref));
    }
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Deja marcados solo `refs` (Commit File/Directory…). */
  setOnlyChecked(refs: readonly FileRef[]): void {
    const keep = new Set(refs.map(keyOf));
    for (const f of this.files) this.overrides.set(keyOf(f), keep.has(keyOf(f)));
    for (const k of this.partial.keys()) if (!keep.has(k)) this.partial.delete(k);
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Para `onDidChangeCheckboxState` (con `manageCheckboxStateManually`). */
  onCheckboxChange(event: vscode.TreeCheckboxChangeEvent<ChangeNode>): void {
    for (const [node, state] of event.items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      for (const ref of filesOf(node)) {
        this.overrides.set(keyOf(ref), checked);
        this.partial.delete(keyOf(ref));
      }
    }
    this.changeEmitter.fire(undefined);
    this.checkedEmitter.fire();
  }

  /** Activa o desactiva una opción de "Group By" o "Show Ignored Files". */
  toggleGrouping(option: keyof ChangesGrouping): void {
    this.grouping = { ...this.grouping, [option]: !this.grouping[option] };
    void this.memento.update(GROUPING_KEY, this.grouping);
    this.publishGrouping();
    if (option === 'showIgnored') void this.refresh();
    else this.changeEmitter.fire(undefined);
  }

  private publishGrouping(): void {
    void vscode.commands.executeCommand('setContext', 'multigit.changesGroupByRepo', this.grouping.repo);
    void vscode.commands.executeCommand('setContext', 'multigit.changesGroupByDir', this.grouping.directory);
    void vscode.commands.executeCommand('setContext', 'multigit.changesGroupByModule', this.grouping.module);
    void vscode.commands.executeCommand('setContext', 'multigit.changesShowIgnored', this.grouping.showIgnored);
  }

  private get modeId(): string {
    const g = this.grouping;
    return `${g.repo ? 'r' : ''}${g.module ? 'm' : ''}${g.directory ? 'd' : ''}`;
  }

  /** Niveles de agrupación activos, en orden. */
  private get levels(): Level[] {
    const g = this.grouping;
    return [...(g.repo ? ['repo' as const] : []), ...(g.module ? ['module' as const] : []), ...(g.directory ? ['dir' as const] : [])];
  }

  // ------------------------------------------------------------------ árbol

  async getChildren(node?: ChangeNode): Promise<ChangeNode[]> {
    if (!node) {
      if (this.loading) await this.loading;
      const changes = this.files.filter(inChangelists);
      const unversioned = this.files.filter((f) => f.file.kind === 'untracked');
      const ignored = this.files.filter((f) => f.file.kind === 'ignored');
      // Una sección por changelist (aunque esté vacía, como IntelliJ).
      const sections: ChangeNode[] = orderedLists(this.lists).map((l) => ({
        kind: 'section' as const,
        section: 'changes' as const,
        list: l.id,
        files: changes.filter((f) => this.listOfRef(f) === l.id),
      }));
      if (unversioned.length) sections.push({ kind: 'section', section: 'unversioned', files: unversioned });
      if (this.grouping.showIgnored && ignored.length) sections.push({ kind: 'section', section: 'ignored', files: ignored });
      return sections;
    }
    switch (node.kind) {
      case 'section':
        return this.group(node.section, node.files, 0, null, node.list);
      case 'repo':
        return this.group(node.section, node.files, node.depth + 1, null, node.list);
      case 'module':
        return this.group(node.section, node.files, node.depth + 1, node.moduleRel, node.list);
      case 'dir':
        return sortFiles(node.files).map((ref) => ({ kind: 'file', section: node.section, ref, list: node.list }));
      case 'file':
        return [];
    }
  }

  /** Hijos para el nivel `depth` de agrupación (o los archivos, si no quedan niveles). */
  private group(section: Section, files: FileRef[], depth: number, moduleRel: string | null, list?: string): ChangeNode[] {
    const scope = scopeOf(section, list);
    const level = this.levels[depth];
    const hasRepoLevel = this.grouping.repo;
    if (level === 'repo') {
      return this.manager.all
        .map((repo) => ({ kind: 'repo' as const, section, repo, files: files.filter((f) => f.repo === repo), depth, list }))
        .filter((n) => n.files.length > 0);
    }
    if (level === 'module') {
      const byModule = new Map<string, FileRef[]>();
      for (const ref of files) {
        const key = `${ref.repo.root}\0${this.moduleOf(ref)}`;
        byModule.set(key, [...(byModule.get(key) ?? []), ref]);
      }
      return [...byModule.entries()]
        .map(([key, inModule]) => {
          const ref = inModule[0]!;
          const rel = key.slice(key.indexOf('\0') + 1);
          // Con nivel repo, la ruta del módulo dentro del repo; sin él, la ruta desde el workspace.
          const label = hasRepoLevel
            ? rel || ref.repo.name
            : this.relativeDirToWorkspace(path.join(ref.repo.root, rel)) || ref.repo.name;
          return {
            kind: 'module' as const,
            section,
            list,
            id: `module/${scope}/${this.modeId}/${key}`,
            label,
            files: inModule,
            depth,
            moduleRel: rel,
          };
        })
        .sort((x, y) => x.label.localeCompare(y.label));
    }
    if (level === 'dir') {
      // Directorio relativo al módulo, al repo o al workspace, según los niveles de arriba.
      const dirOf = (ref: FileRef) => {
        const dir = path.posix.dirname(ref.file.path.replace(/\/$/, ''));
        if (moduleRel !== null) return path.posix.relative(moduleRel || '.', dir) || '.';
        if (hasRepoLevel) return dir;
        return this.relativeToWorkspace(ref);
      };
      return this.dirNodes(section, files, dirOf, `${depth}/${moduleRel ?? ''}`, list);
    }
    return this.flatFiles(section, files, list);
  }

  /** Módulo de un archivo: la carpeta más cercana (hasta la raíz del repo) con un manifiesto. */
  private readonly moduleCache = new Map<string, boolean>();
  private moduleOf(ref: FileRef): string {
    let dir = path.posix.dirname(ref.file.path.replace(/\/$/, ''));
    while (dir !== '.' && dir !== '') {
      const abs = path.join(ref.repo.root, dir);
      let isModule = this.moduleCache.get(abs);
      if (isModule === undefined) {
        isModule = MODULE_MANIFESTS.some((m) => existsSync(path.join(abs, m)));
        this.moduleCache.set(abs, isModule);
      }
      if (isModule) return dir;
      dir = path.posix.dirname(dir);
    }
    return '';
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        if (node.list) return this.changelistItem(node, node.list);
        const label = node.section === 'unversioned' ? 'Unversioned Files' : 'Ignored Files';
        const item = new vscode.TreeItem(
          label,
          node.section === 'ignored' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `section/${node.section}/${this.modeId}`;
        item.description = t('{0} file(s)', node.files.length);
        if (node.section !== 'ignored') item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.section.${node.section}`;
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `repo/${scopeOf(node.section, node.list)}/${node.repo.root}/${this.modeId}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        const head = node.repo.status ? `⎇ ${describeHead(node.repo.status)}` : '';
        item.description = `${head}  ${node.files.length}`;
        if (node.section !== 'ignored') item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.repo.${node.section}`;
        return item;
      }
      case 'module': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon('package');
        item.description = String(node.files.length);
        if (node.section !== 'ignored') item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.dir.${node.section}`;
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = String(node.files.length);
        if (node.section !== 'ignored') item.checkboxState = this.containerState(node.files);
        item.contextValue = `multigit.changes.dir.${node.section}`;
        return item;
      }
      case 'file': {
        const { repo, file } = node.ref;
        const item = new vscode.TreeItem(path.posix.basename(file.path.replace(/\/$/, '')), vscode.TreeItemCollapsibleState.None);
        item.id = `file/${scopeOf(node.section, node.list)}/${this.modeId}/${keyOf(node.ref)}`;
        // resourceUri: ícono del tema de archivos y color/letra de la extensión git integrada.
        item.resourceUri = vscode.Uri.file(path.join(repo.root, file.path));
        // Sin carpetas en el árbol, la ruta va en gris al lado (como IntelliJ); sin repos, el repo.
        const where = this.grouping.directory
          ? this.grouping.repo || this.grouping.module
            ? ''
            : repo.name
          : this.relativeToWorkspace(node.ref);
        const partial = this.isChecked(node.ref) ? this.partialOf(node.ref) : undefined;
        const parts = [partial ? t('{0}/{1} lines', partial.selected.length, partial.total) : '', where, file.origPath ? `← ${file.origPath}` : ''];
        item.description = parts.filter(Boolean).join('  ');
        item.tooltip = `${statusLabel(file.status)}: ${repo.name}/${file.path}${partial ? `\n${t('Partial commit: {0} of {1} changed lines', partial.selected.length, partial.total)}` : ''}`;
        item.contextValue = `multigit.changes.file.${file.kind}`;
        if (file.kind === 'ignored') {
          // Los ignorados no se commitean: sin checkbox; clic → mostrarlo en el Explorer.
          item.command = { command: 'revealInExplorer', title: t('Show'), arguments: [item.resourceUri] };
          return item;
        }
        item.checkboxState = this.isChecked(node.ref)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.command = { command: 'multigit.changes.openDiff', title: t('Show Diff'), arguments: [node] };
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }

  /** Nodo de una changelist: nombre (resaltado si es la activa), archivos y su descripción. */
  private changelistItem(node: ChangeNode & { kind: 'section' }, id: string): vscode.TreeItem {
    const list = this.lists.lists.find((l) => l.id === id)!;
    const active = id === this.lists.active;
    const multiple = this.lists.lists.length > 1;
    const item = new vscode.TreeItem(
      active && multiple ? { label: list.name, highlights: [[0, list.name.length]] } : list.name,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `section/changes:${id}/${this.modeId}`;
    item.description = [t('{0} file(s)', node.files.length), active && multiple ? t('active') : ''].filter(Boolean).join(' · ');
    item.tooltip = [list.name + (active ? ` (${t('active changelist')})` : ''), list.comment ?? ''].filter(Boolean).join('\n\n');
    if (multiple) item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'list-unordered');
    item.checkboxState = this.containerState(node.files);
    // `.changes` como antes (Rollback, Commit…) más si es la de por defecto y/o la activa.
    item.contextValue = `multigit.changes.section.changes${id === DEFAULT_LIST ? '.default' : ''}${active ? '.active' : ''}`;
    return item;
  }

  // ------------------------------------------------------------------ helpers

  private containerState(files: readonly FileRef[]): vscode.TreeItemCheckboxState {
    return files.length > 0 && files.every((f) => this.isChecked(f))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  /** Agrupa archivos por directorio; los de la raíz van sueltos. */
  private dirNodes(section: Section, files: FileRef[], dirOf: (ref: FileRef) => string, scope: string, list?: string): ChangeNode[] {
    const byDir = new Map<string, FileRef[]>();
    for (const ref of files) {
      const dir = dirOf(ref);
      const inDir = byDir.get(dir) ?? [];
      inDir.push(ref);
      byDir.set(dir, inDir);
    }
    const nodes: ChangeNode[] = [];
    for (const [dir, group] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (dir === '.' || dir === '') {
        nodes.push(...sortFiles(group).map((ref) => ({ kind: 'file' as const, section, ref, list })));
      } else {
        nodes.push({ kind: 'dir', section, list, id: `dir/${scopeOf(section, list)}/${this.modeId}/${scope}/${dir}`, label: dir, files: group });
      }
    }
    // Carpetas primero, luego archivos sueltos (como el explorador).
    return nodes.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file'));
  }

  /** Archivos sin carpetas, ordenados por ruta. */
  private flatFiles(section: Section, files: readonly FileRef[], list?: string): ChangeNode[] {
    return [...files]
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .map((ref) => ({ kind: 'file' as const, section, ref, list }));
  }

  /** Ruta de una carpeta relativa a la raíz común del workspace. */
  private relativeDirToWorkspace(absDir: string): string {
    const roots = this.manager.all.map((r) => r.root);
    const base = roots.length === 1 ? path.dirname(roots[0]!) : commonAncestor(roots);
    return path.relative(base, absDir).split(path.sep).join('/');
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
