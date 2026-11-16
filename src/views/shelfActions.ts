// Acciones de la vista Shelf (como la pestaña Shelf de IntelliJ): Unshelve completo, Unshelve de archivos
// sueltos (los que se eligen en el árbol), Rename y Delete. Un shelf es un stash "MultiGit: <nombre>".
import * as vscode from 'vscode';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import { SHELF_PREFIX } from '../git/stashes';
import { StashesTree, type StashFile, type StashNode, type StashTarget } from './StashesTree';
import type { StashActions } from './stashActions';
import { t } from '../i18n';

export class ShelfActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly tree: StashesTree,
    private readonly stashes: StashActions,
  ) {}

  /** Unshelve: aplica el shelf entero en cada repo y lo borra (stash pop). */
  async unshelve(targets: readonly StashTarget[]): Promise<void> {
    if (!targets.length) return;
    const name = StashesTree.title(targets[0]!.stash.message);
    const hashes = new Map(targets.map((x) => [x.repo, x.stash.hash]));
    await runInRepos(this.manager, {
      title: t("Unshelve '{0}'", name),
      repos: targets.map((x) => x.repo),
      continueAfterConflict: true,
      run: async (repo) => {
        await repo.git.stashPop(await this.stashes.resolve(repo, hashes.get(repo)!));
      },
    });
    this.tree.refresh();
  }

  /**
   * Unshelve de los archivos elegidos (Ctrl/Cmd+clic en el árbol): se aplican como patch; si no encaja
   * limpio, se ofrece el merge a 3 bandas. Si de un shelf se aplicaron todos sus archivos, se borra.
   */
  async unshelveFiles(nodes: readonly StashNode[]): Promise<void> {
    type Pick = { repo: Repo; hash: string; ref: string; message: string; files: StashFile[] };
    const picks: Pick[] = [];
    for (const n of nodes) {
      if (n.kind !== 'file') continue;
      let p = picks.find((x) => x.repo === n.repo && x.hash === n.stash.hash);
      if (!p) picks.push((p = { repo: n.repo, hash: n.stash.hash, ref: n.stash.ref, message: n.stash.message, files: [] }));
      if (!p.files.some((f) => f.path === n.file.path)) p.files.push(n.file);
    }
    if (!picks.length) return;
    const name = StashesTree.title(picks[0]!.message);
    const total = picks.reduce((n, p) => n + p.files.length, 0);

    // Comprobar dónde encaja limpio.
    const patches = new Map<Pick, string>();
    const failing = new Map<Pick, string>();
    for (const p of picks) {
      const patch = await p.repo.git.stashPatch(p.hash, p.files);
      patches.set(p, patch);
      await p.repo.git.applyPatch(patch, 'check').catch((error) => failing.set(p, errorText(error)));
    }
    const lines = picks.flatMap((p) => [`${failing.has(p) ? '⚠' : '✓'} ${p.repo.name}:`, ...p.files.map((f) => `    ${f.path}`)]);
    const OK = failing.size ? t('Apply with 3-way Merge') : t('Unshelve');
    const choice = await vscode.window.showWarningMessage(
      t("Unshelve {0} file(s) from '{1}'?", total, name),
      {
        modal: true,
        detail: [
          ...lines,
          '',
          failing.size
            ? t('In the ⚠ repositories the files do not apply cleanly: with a 3-way merge, conflicts are left to resolve.')
            : t('The changes go to your working tree.'),
          t('Files applied from a shelf are removed from it; when none are left, the shelf is deleted.'),
        ].join('\n'),
      },
      OK,
    );
    if (choice !== OK) return;

    await runInRepos(this.manager, {
      title: t("Unshelve from '{0}'", name),
      repos: [...new Set(picks.map((p) => p.repo))],
      continueAfterConflict: true,
      run: async (repo) => {
        const mine = picks.filter((p) => p.repo === repo);
        const notes: string[] = [];
        for (const p of mine) {
          await repo.git.applyPatch(patches.get(p)!, failing.has(p) ? 'threeWay' : 'apply');
          notes.push(await this.removeFromShelf(repo, p.hash, p.files));
        }
        return [t('{0} file(s)', mine.reduce((n, p) => n + p.files.length, 0)), ...notes.filter(Boolean)].join(' · ');
      },
    });
    this.tree.refresh();
  }

  /**
   * Quita del shelf los archivos ya aplicados (como IntelliJ): se vuelve a guardar con los que quedan, o se
   * borra si no queda ninguno. Devuelve una nota para el resumen.
   */
  private async removeFromShelf(repo: Repo, hash: string, applied: readonly StashFile[]): Promise<string> {
    const all = await repo.git.stashFiles(hash);
    const done = new Set(applied.map((f) => f.path));
    const rest = all.filter((f) => !done.has(f.path));
    const ref = await this.stashes.resolve(repo, hash);
    if (!rest.length) {
      await repo.git.stashDrop(ref);
      return t('shelf emptied and deleted');
    }
    const entry = (await repo.git.listStashes()).find((s) => s.hash === hash);
    const subject = `${entry?.branch ? `On ${entry.branch}: ` : ''}${entry?.message ?? `${SHELF_PREFIX}shelf`}`;
    await repo.git.rebuildStash(hash, rest, subject);
    await repo.git.stashDrop(await this.stashes.resolve(repo, hash));
    return t('{0} file(s) left in the shelf', rest.length);
  }

  /** Rename Shelf: vuelve a guardar el stash con el nombre nuevo y borra el viejo. */
  async rename(targets: readonly StashTarget[]): Promise<void> {
    if (!targets.length) return;
    const current = StashesTree.title(targets[0]!.stash.message);
    const name = (
      await vscode.window.showInputBox({
        title: t('Rename Shelf'),
        value: current,
        validateInput: (v) => (v.trim() ? undefined : t('Type a name')),
      })
    )?.trim();
    if (!name || name === current) return;
    const byRepo = new Map(targets.map((x) => [x.repo, x.stash]));
    await runInRepos(this.manager, {
      title: t("Rename shelf '{0}' to '{1}'", current, name),
      repos: targets.map((x) => x.repo),
      check: () => undefined,
      run: async (repo) => {
        const stash = byRepo.get(repo)!;
        const on = stash.branch ? `On ${stash.branch}: ` : '';
        await repo.git.renameStash(stash.hash, `${on}${SHELF_PREFIX}${name}`);
        await repo.git.stashDrop(await this.stashes.resolve(repo, stash.hash));
      },
    });
    this.tree.refresh();
  }

  /** Delete Shelf (con confirmación). */
  async remove(targets: readonly StashTarget[]): Promise<void> {
    await this.stashes.drop(targets);
  }
}
