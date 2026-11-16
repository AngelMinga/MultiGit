// Vista Changes propia (webview), como la ventana Commit de IntelliJ: casillas gris / azul / parcial ("−"),
// iconos por tipo de archivo y el color de cada repo. El modelo sigue siendo ChangesTree (agrupación,
// changelists, marcas, commit parcial); aquí solo se convierte en filas y se reciben los clics.
//
// Los menús contextuales son los nativos de VS Code (`webview/context`): cada fila lleva
// `data-vscode-context` con `viewItem` (el contextValue de antes) y `nodeId`; el comando recibe ese
// objeto y `resolve()` lo convierte en el nodo.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangelistActions } from './changelistActions';
import { filesOf, keyOf, type ChangeNode, type ChangesTree } from './ChangesTree';
import type { ChangesCheck, ChangesIcon, ChangesRow, WebviewMessage } from '../webview/protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from '../webview/webviewHtml';
import { t } from '../i18n';

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

/** Color del nombre según el estado (las mismas variables que usa la extensión Git de VS Code). */
const STATUS_COLOR: Record<string, string> = {
  M: '--vscode-gitDecoration-modifiedResourceForeground',
  T: '--vscode-gitDecoration-modifiedResourceForeground',
  A: '--vscode-gitDecoration-addedResourceForeground',
  C: '--vscode-gitDecoration-addedResourceForeground',
  R: '--vscode-gitDecoration-renamedResourceForeground',
  D: '--vscode-gitDecoration-deletedResourceForeground',
  U: '--vscode-gitDecoration-conflictingResourceForeground',
  '?': '--vscode-gitDecoration-untrackedResourceForeground',
  '!': '--vscode-gitDecoration-ignoredResourceForeground',
};

export class ChangesPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'multigit.changes';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private readonly nodes = new Map<string, ChangeNode>();
  private selectedIds: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly visibilityEmitter = new vscode.EventEmitter<boolean>();
  /** Se hizo visible u oculta (para releer los cambios al volver). */
  readonly onDidChangeVisibility = this.visibilityEmitter.event;
  private inline: MenuItem[] = [];
  private icons = new Map<string, { icon: string; title: string }>();
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extension: vscode.ExtensionContext,
    private readonly tree: ChangesTree,
    private readonly changelists: ChangelistActions,
  ) {
    this.loadMenus();
    this.disposables.push(tree.onDidChangeTreeData(() => this.schedule()), this.visibilityEmitter);
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  /** Ids de las filas enviadas a la vista (para los tests). */
  get rowIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** Nodos elegidos (Ctrl/Cmd+clic, Mayús+clic) en el orden del árbol. */
  get selection(): ChangeNode[] {
    return this.selectedIds.flatMap((id) => (this.nodes.has(id) ? [this.nodes.get(id)!] : []));
  }

  /** Nodo de un argumento de comando: el propio nodo, el contexto de una fila (`nodeId`) o nada. */
  resolve(arg: unknown): ChangeNode | undefined {
    if (!arg || typeof arg !== 'object') return undefined;
    if ('nodeId' in arg && typeof (arg as { nodeId: unknown }).nodeId === 'string') return this.nodes.get((arg as { nodeId: string }).nodeId);
    if ('kind' in arg) return arg as ChangeNode;
    return undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extension.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extension.extensionUri, 'changes', 'Changes');
    this.disposables.push(
      onWebviewMessage(view.webview, (m) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => this.visibilityEmitter.fire(view.visible)),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${ChangesPanel.viewId}.focus`);
    if (this.view && this.ready) void postToWebview(this.view.webview, { type: 'changes/focus', payload: {} });
  }

  // ------------------------------------------------------------------ mensajes

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.visibilityEmitter.fire(true);
        await this.send();
        return;
      case 'changes/select':
        this.selectedIds = message.payload.ids;
        return;
      case 'changes/check': {
        const items = message.payload.ids.flatMap((id) => (this.nodes.has(id) ? [this.nodes.get(id)!] : []));
        const state = message.payload.checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        this.tree.onCheckboxChange({ items: items.map((n) => [n, state] as [ChangeNode, vscode.TreeItemCheckboxState]) });
        return;
      }
      case 'changes/click': {
        const node = this.nodes.get(message.payload.id);
        const command = node && (await this.tree.getTreeItem(node)).command;
        if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
        return;
      }
      case 'changes/action': {
        const node = this.nodes.get(message.payload.id);
        if (node) await vscode.commands.executeCommand(message.payload.command, node);
        return;
      }
      case 'changes/runCommand':
        await vscode.commands.executeCommand(message.payload.command);
        return;
      case 'changes/drop': {
        const target = this.nodes.get(message.payload.target);
        const nodes = message.payload.ids.flatMap((id) => (this.nodes.has(id) ? [this.nodes.get(id)!] : []));
        if (target && nodes.length) await this.changelists.dropOn(target, nodes);
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ filas

  /** Agrupa ráfagas de cambios del árbol en un solo envío. */
  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.send();
    }, 30);
  }

  private async send(): Promise<void> {
    if (!this.view || !this.ready) return;
    this.nodes.clear();
    const rows = await this.rowsOf(undefined);
    this.selectedIds = this.selectedIds.filter((id) => this.nodes.has(id));
    void postToWebview(this.view.webview, { type: 'changes/state', payload: { rows, empty: t('There are no uncommitted changes in the repositories.') } });
  }

  private async rowsOf(parent: ChangeNode | undefined): Promise<ChangesRow[]> {
    const children = (await this.tree.getChildren(parent)) ?? [];
    return Promise.all(children.map((node) => this.rowOf(node)));
  }

  private async rowOf(node: ChangeNode): Promise<ChangesRow> {
    const item = await this.tree.getTreeItem(node);
    const id = item.id ?? `${node.kind}:${Math.random()}`;
    this.nodes.set(id, node);
    const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
    const contextValue = item.contextValue ?? '';
    const file = node.kind === 'file' ? node.ref.file : undefined;
    return {
      id,
      label,
      bold: typeof item.label === 'object' && !!item.label?.highlights?.length,
      description: typeof item.description === 'string' ? item.description : undefined,
      tooltip: typeof item.tooltip === 'string' ? item.tooltip : (item.tooltip?.value ?? undefined),
      contextValue,
      check: item.checkboxState === undefined ? null : this.checkOf(node),
      icon: this.iconOf(node, item),
      status: file ? (file.kind === 'untracked' ? 'U' : file.status === '!' ? '' : file.status) : undefined,
      color: file ? STATUS_COLOR[file.kind === 'untracked' ? '?' : file.status] : undefined,
      clickable: !!item.command,
      actions: this.actionsFor(contextValue),
      draggable: node.kind !== 'section' && node.section !== 'ignored',
      droppable: !!node.list,
      collapsed: item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed,
      children: item.collapsibleState === vscode.TreeItemCollapsibleState.None ? [] : await this.rowsOf(node),
    };
  }

  /** Casilla de tres estados, como IntelliJ: parcial si solo algunos archivos (o líneas) entran. */
  private checkOf(node: ChangeNode): ChangesCheck {
    const files = filesOf(node).filter((r) => r.file.kind !== 'ignored');
    const checked = files.filter((r) => this.tree.isChecked(r));
    if (!checked.length) return 'unchecked';
    if (checked.length < files.length) return 'mixed';
    return checked.some((r) => this.tree.partialOf(r)) ? 'mixed' : 'checked';
  }

  private iconOf(node: ChangeNode, item: vscode.TreeItem): ChangesIcon | undefined {
    if (node.kind === 'repo') return { kind: 'repo', color: `--vscode-${this.tree.colorIdOf(node.repo).replace(/\./g, '-')}` };
    if (node.kind === 'file') return { kind: 'file', ext: path.posix.extname(node.ref.file.path).slice(1).toLowerCase() || path.posix.basename(node.ref.file.path).toLowerCase() };
    const icon = item.iconPath;
    if (icon instanceof vscode.ThemeIcon) return { kind: 'codicon', name: icon.id };
    return undefined;
  }

  // ------------------------------------------------------------------ acciones inline (de package.json)

  /** Las acciones `inline` de `view/item/context` para Changes, con su icono y título. */
  private loadMenus(): void {
    const pkg = this.extension.extension.packageJSON as {
      contributes: { menus: Record<string, MenuItem[]>; commands: Array<{ command: string; title: string; icon?: string }> };
    };
    this.inline = (pkg.contributes.menus['view/item/context'] ?? [])
      .filter((m) => m.group?.startsWith('inline') && (m.when ?? '').includes('view == multigit.changes'))
      .sort((a, b) => order(a.group) - order(b.group));
    for (const c of pkg.contributes.commands) {
      const icon = /^\$\(([^)]+)\)$/.exec(c.icon ?? '')?.[1];
      if (icon) this.icons.set(c.command, { icon, title: localizeTitle(this.extension, c.title) });
    }
  }

  private actionsFor(contextValue: string): ChangesRow['actions'] {
    return this.inline
      .filter((m) => matchesWhen(m.when ?? '', contextValue) && this.icons.has(m.command))
      .map((m) => ({ command: m.command, ...this.icons.get(m.command)! }));
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    for (const d of this.disposables) d.dispose();
  }
}

function order(group: string | undefined): number {
  return Number(/@(\d+)/.exec(group ?? '')?.[1] ?? 0);
}

/** Condición `when` de un menú de Changes: solo `view == …`, `viewItem == …` y `viewItem =~ /…/` unidos con `&&`. */
export function matchesWhen(when: string, contextValue: string): boolean {
  return when.split('&&').every((part) => {
    const p = part.trim();
    if (p.startsWith('view ==')) return p.endsWith('multigit.changes');
    const eq = /^viewItem\s*==\s*(.+)$/.exec(p);
    if (eq) return eq[1]!.trim() === contextValue;
    const re = /^viewItem\s*=~\s*\/(.+)\/([a-z]*)$/.exec(p);
    if (re) return new RegExp(re[1]!, re[2]).test(contextValue);
    return true;
  });
}

/** Título de un comando: los `%clave%` se buscan en package.nls del idioma de VS Code. */
function localizeTitle(context: vscode.ExtensionContext, title: string): string {
  const key = /^%(.+)%$/.exec(title)?.[1];
  if (!key) return title;
  const read = (file: string): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path.join(context.extensionPath, file), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const lang = vscode.env.language.toLowerCase();
  return read(`package.nls.${lang}.json`)[key] ?? read(`package.nls.${lang.split('-')[0]}.json`)[key] ?? read('package.nls.json')[key] ?? key;
}

/** Ids de los archivos de unos nodos (para comprobar en tests). */
export function fileKeys(nodes: readonly ChangeNode[]): string[] {
  return nodes.flatMap((n) => filesOf(n)).map(keyOf);
}
