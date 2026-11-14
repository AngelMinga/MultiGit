// Acciones de changelists (como IntelliJ): New Changelist…, Move to Another Changelist… (F6), Set Active
// Changelist, Edit Changelist… y Delete Changelist. También arrastrar archivos de una lista a otra.
import * as vscode from 'vscode';
import {
  addList,
  DEFAULT_LIST,
  editList,
  moveTo,
  orderedLists,
  removeList,
  setActive,
  validateName,
  type ChangelistState,
} from '../git/changelists';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo } from '../git/RepoManager';
import { keyOf, type ChangeNode, type ChangesTree, type FileRef } from './ChangesTree';
import { t } from '../i18n';

const MIME = 'application/vnd.code.tree.multigit.changes';

export class ChangelistActions implements vscode.TreeDragAndDropController<ChangeNode> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(private readonly tree: ChangesTree) {}

  private nameError(state: ChangelistState, name: string, exceptId?: string): string | undefined {
    const problem = validateName(state, name, exceptId);
    return problem === 'empty' ? t('Type a name') : problem === 'duplicate' ? t('There is already a changelist with that name') : undefined;
  }

  /** New Changelist…: la crea (y, si se pasan, mueve ahí esos archivos). Devuelve su id. */
  async create(refs: readonly FileRef[] = []): Promise<string | undefined> {
    const state = this.tree.changelists;
    const name = await vscode.window.showInputBox({
      title: t('New Changelist'),
      prompt: t('Name of the changelist (e.g. the task you are working on)'),
      validateInput: (v) => this.nameError(state, v),
    });
    if (!name?.trim()) return undefined;
    const ACTIVE = t('Yes, make it active');
    const makeActive = await vscode.window.showQuickPick([ACTIVE, t('No')], {
      title: t("Changelist '{0}'", name.trim()),
      placeHolder: t('Make it the active changelist? (new changes go to the active one)'),
    });
    if (makeActive === undefined) return undefined;
    const id = `cl-${Date.now().toString(36)}`;
    let next = addList(this.tree.changelists, id, name);
    if (makeActive === ACTIVE) next = setActive(next, id);
    if (refs.length) next = await this.assign(next, refs, id);
    this.tree.updateLists(next, refs);
    return id;
  }

  /** Move to Another Changelist… (F6). Los sin versionar se añaden a Git al moverlos (como IntelliJ). */
  async move(refs: readonly FileRef[]): Promise<void> {
    if (!refs.length) return;
    const state = this.tree.changelists;
    const current = new Set(refs.filter((r) => r.file.kind !== 'untracked').map((r) => this.tree.listOfRef(r)));
    type Item = vscode.QuickPickItem & { id?: string; create?: boolean };
    const items: Item[] = [
      ...orderedLists(state)
        .filter((l) => !(current.size === 1 && current.has(l.id) && refs.every((r) => r.file.kind !== 'untracked')))
        .map((l) => ({
          label: `$(${l.id === state.active ? 'pass-filled' : 'list-unordered'}) ${l.name}`,
          description: [l.id === state.active ? t('active') : '', t('{0} file(s)', this.tree.filesInList(l.id).length)].filter(Boolean).join(' · '),
          id: l.id,
        })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: t('$(add) New Changelist…'), create: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Move {0} file(s) to Another Changelist', refs.length),
      placeHolder: t('Target changelist'),
    });
    if (!picked) return;
    if (picked.create) {
      await this.create(refs);
      return;
    }
    if (picked.id) this.tree.updateLists(await this.assign(this.tree.changelists, refs, picked.id), refs);
  }

  /** Asigna los archivos a la lista; los sin versionar primero se añaden a Git. */
  private async assign(state: ChangelistState, refs: readonly FileRef[], id: string): Promise<ChangelistState> {
    const untracked = refs.filter((r) => r.file.kind === 'untracked');
    const byRepo = new Map<Repo, string[]>();
    for (const r of untracked) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r.file.path]);
    const errors: string[] = [];
    for (const [repo, paths] of byRepo) {
      try {
        await repo.git.addPaths(paths);
      } catch (error) {
        errors.push(`${repo.name}: ${errorText(error)}`);
      }
    }
    if (errors.length) void vscode.window.showErrorMessage(t('MultiGit: some files could not be added to Git'), { modal: true, detail: errors.join('\n') });
    const next = moveTo(state, refs.map(keyOf), id);
    if (untracked.length) void this.tree.refresh();
    return next;
  }

  setActive(id: string): void {
    this.tree.updateLists(setActive(this.tree.changelists, id), this.tree.filesInList(id).concat(this.tree.filesInList(this.tree.changelists.active)));
  }

  /** Edit Changelist…: nombre y descripción. */
  async edit(id: string): Promise<void> {
    const state = this.tree.changelists;
    const list = state.lists.find((l) => l.id === id);
    if (!list) return;
    const name = await vscode.window.showInputBox({
      title: t('Edit Changelist'),
      prompt: t('Name'),
      value: list.name,
      validateInput: (v) => this.nameError(state, v, id),
    });
    if (!name?.trim()) return;
    const comment = await vscode.window.showInputBox({
      title: t("Changelist '{0}'", name.trim()),
      prompt: t('Description (optional): it is proposed as the commit message when the box is empty'),
      value: list.comment ?? '',
    });
    if (comment === undefined) return;
    this.tree.updateLists(editList(this.tree.changelists, id, name, comment));
  }

  /** Delete Changelist: sus archivos pasan a la lista por defecto. */
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_LIST) return;
    const state = this.tree.changelists;
    const list = state.lists.find((l) => l.id === id);
    if (!list) return;
    const files = this.tree.filesInList(id);
    if (files.length) {
      const target = state.lists.find((l) => l.id === DEFAULT_LIST)!.name;
      const OK = t('Delete');
      const choice = await vscode.window.showWarningMessage(
        t("Delete changelist '{0}'?", list.name),
        { modal: true, detail: t("Its {0} file(s) move to '{1}'. The changes are not lost.", files.length, target) },
        OK,
      );
      if (choice !== OK) return;
    }
    this.tree.updateLists(removeList(state, id), files);
  }

  // ------------------------------------------------------------------ arrastrar y soltar

  handleDrag(source: readonly ChangeNode[], data: vscode.DataTransfer): void {
    data.set(MIME, new vscode.DataTransferItem(source));
  }

  async handleDrop(target: ChangeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const nodes = data.get(MIME)?.value as ChangeNode[] | undefined;
    // Solo se suelta sobre una changelist o sobre algo que está dentro de una.
    const id = target?.list;
    if (!nodes?.length || !id) return;
    const seen = new Set<string>();
    const refs = nodes
      .flatMap((n) => (n.kind === 'file' ? [n.ref] : n.files))
      .filter((r) => r.file.kind !== 'ignored' && !seen.has(keyOf(r)) && seen.add(keyOf(r)) && (r.file.kind === 'untracked' || this.tree.listOfRef(r) !== id));
    if (!refs.length) return;
    this.tree.updateLists(await this.assign(this.tree.changelists, refs, id), refs);
  }
}
