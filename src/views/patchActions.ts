// Create Patch / Apply Patch (como IntelliJ). Un patch de varios repos lleva las rutas relativas a la
// carpeta común (`mftheme/src/a.ts`); al aplicarlo, cada archivo va a su repo (ver src/git/patches.ts).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commonAncestor } from '../git/branches';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import { assignPatch, combinePatches, joinPatch, parsePatch, patchFileName, patchPath, type PatchFile } from '../git/patches';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { FileRef } from './ChangesTree';
import { t } from '../i18n';

export class PatchActions {
  constructor(private readonly manager: RepoManager) {}

  /** Carpeta común de los repos: las rutas de un patch de varios repos son relativas a ella. */
  private get base(): string {
    const roots = this.manager.allRepos.map((r) => r.root);
    return roots.length === 1 ? path.dirname(roots[0]!) : commonAncestor(roots);
  }

  private dirOf(repo: Repo): string {
    return path.relative(this.base, repo.root).split(path.sep).join('/');
  }

  // ------------------------------------------------------------------ crear

  /** Create Patch… de los archivos elegidos en Changes. */
  async createFromChanges(refs: readonly FileRef[]): Promise<void> {
    const repos = [...new Set(refs.map((r) => r.repo))];
    const parts: Array<{ repo: Repo; patch: string }> = [];
    for (const repo of repos) {
      const files = refs.filter((r) => r.repo === repo).map((r) => r.file);
      const tracked = files.filter((f) => f.kind !== 'untracked').flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]));
      let patch = await repo.git.patchTracked(tracked);
      for (const f of files.filter((x) => x.kind === 'untracked')) patch += await repo.git.patchUntracked(f.path);
      if (patch.trim()) parts.push({ repo, patch });
    }
    if (!parts.length) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no differences for a patch.'));
      return;
    }
    // Un solo repo: rutas del repo (git normal). Varios: relativas a la carpeta común, como IntelliJ.
    const text = parts.length === 1 ? parts[0]!.patch : combinePatches(parts.map((p) => ({ dir: this.dirOf(p.repo), patch: p.patch })));
    const branches = [...new Set(parts.map((p) => p.repo.status?.branch).filter(Boolean))];
    await this.output(text, branches.length === 1 ? branches[0]! : 'changes', parts.length);
  }

  /** Create Patch… de un commit del Git Log (`format-patch`, con autor y mensaje). */
  async createFromCommit(repo: Repo, hash: string): Promise<void> {
    const text = await repo.git.commitPatch(hash);
    const subject = (await repo.git.commitInfo(hash).catch(() => undefined))?.body.split('\n')[0] ?? hash.slice(0, 7);
    await this.output(text, `${hash.slice(0, 7)}-${subject}`, 1);
  }

  /** Guardar en un archivo o copiar al portapapeles (como las dos opciones del diálogo de IntelliJ). */
  private async output(text: string, name: string, repos: number): Promise<void> {
    const count = parsePatch(text).length;
    const picked = await vscode.window.showQuickPick(
      [
        { label: t('$(save) Save to File…'), id: 'file' },
        { label: t('$(copy) Copy to Clipboard'), id: 'clipboard' },
      ],
      { title: t('Create Patch — {0} file(s) in {1} repositories', count, repos) },
    );
    if (!picked) return;
    if (picked.id === 'clipboard') {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(t('$(copy) Patch of {0} file(s) copied', count), 4000);
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      title: t('Save Patch'),
      defaultUri: vscode.Uri.file(path.join(this.base, patchFileName(name))),
      filters: { Patch: ['patch', 'diff'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    const OPEN = t('Open');
    const choice = await vscode.window.showInformationMessage(t('MultiGit: patch saved in {0}', uri.fsPath), OPEN);
    if (choice === OPEN) await vscode.window.showTextDocument(uri);
  }

  // ------------------------------------------------------------------ aplicar

  /** Apply Patch…: de un archivo (`uri`, o se elige), o del portapapeles (`'clipboard'`). */
  async apply(source?: vscode.Uri | 'clipboard'): Promise<void> {
    let from = source;
    if (!from) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: t('$(file) From File…'), id: 'file' },
          { label: t('$(clippy) From Clipboard'), id: 'clipboard' },
        ],
        { title: t('Apply Patch') },
      );
      if (!picked) return;
      if (picked.id === 'clipboard') from = 'clipboard';
      else {
        const uris = await vscode.window.showOpenDialog({
          title: t('Apply Patch'),
          canSelectMany: false,
          defaultUri: vscode.Uri.file(this.base),
          filters: { Patch: ['patch', 'diff'], [t('All files')]: ['*'] },
        });
        from = uris?.[0];
      }
    }
    if (!from) return;
    const text = from === 'clipboard' ? await vscode.env.clipboard.readText() : Buffer.from(await vscode.workspace.fs.readFile(from)).toString('utf8');
    const files = parsePatch(text);
    if (!files.length) {
      void vscode.window.showErrorMessage(from === 'clipboard' ? t('MultiGit: the clipboard does not contain a patch.') : t('MultiGit: the file is not a patch.'));
      return;
    }

    const repos = this.manager.allRepos;
    const { byRepo, unmatched } = assignPatch(files, repos.map((repo) => ({ repo, dir: this.dirOf(repo) })));
    if (byRepo.size === 0) {
      // Patch de un solo repo (rutas del repo): elegir dónde, marcando dónde encaja.
      const repo = await this.pickRepo(unmatched, repos);
      if (!repo) return;
      byRepo.set(repo, unmatched);
    } else if (unmatched.length) {
      const GO = t('Apply the Rest');
      const choice = await vscode.window.showWarningMessage(
        t('MultiGit: {0} file(s) of the patch are not in any repository', unmatched.length),
        { modal: true, detail: unmatched.slice(0, 15).map((f) => `  • ${patchPath(f)}`).join('\n') },
        GO,
      );
      if (choice !== GO) return;
    }
    await this.applyTo(byRepo);
  }

  /** Repo donde aplicar un patch sin prefijos: los que lo aceptan limpio van primero. */
  private async pickRepo(files: readonly PatchFile[], repos: readonly Repo[]): Promise<Repo | undefined> {
    const text = joinPatch(files);
    const fits = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: checking the patch…') }, () =>
      Promise.all(repos.map((r) => r.git.applyPatch(text, 'check').then(() => true, () => false))),
    );
    if (repos.length === 1) return repos[0];
    const items = repos
      .map((repo, i) => ({ repo, fits: fits[i]! }))
      .sort((a, b) => Number(b.fits) - Number(a.fits))
      .map(({ repo, fits: ok }) => ({
        label: `${ok ? '$(check)' : '$(warning)'} ${repo.name}`,
        description: ok ? t('applies cleanly') : t('does not apply cleanly'),
        repo,
      }));
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Apply Patch — {0} file(s)', files.length),
      placeHolder: t('Repository where the patch is applied'),
    });
    return picked?.repo;
  }

  /** Comprueba y aplica en cada repo; donde no encaja, ofrece el merge a tres bandas (deja conflictos). */
  private async applyTo(byRepo: Map<Repo, PatchFile[]>): Promise<void> {
    const texts = new Map([...byRepo].map(([repo, files]) => [repo, joinPatch(files)]));
    const failing = new Map<Repo, string>();
    await Promise.all(
      [...texts].map(async ([repo, text]) => {
        try {
          await repo.git.applyPatch(text, 'check');
        } catch (error) {
          failing.set(repo, errorText(error));
        }
      }),
    );
    const lines = [...byRepo].map(([repo, files]) => `${failing.has(repo) ? '⚠' : '✓'} ${repo.name}: ${t('{0} file(s)', files.length)}`);
    let threeWay = false;
    if (failing.size) {
      const MERGE = t('Apply with 3-way Merge');
      const choice = await vscode.window.showWarningMessage(
        t('MultiGit: the patch does not apply cleanly in {0} repositories', failing.size),
        {
          modal: true,
          detail: [
            ...lines,
            '',
            ...[...failing].map(([repo, error]) => `${repo.name}: ${error.split('\n').slice(0, 3).join(' ')}`),
            '',
            t('With a 3-way merge the changes are combined with your versions; where they collide, conflicts are left to resolve.'),
          ].join('\n'),
        },
        MERGE,
      );
      if (choice !== MERGE) return;
      threeWay = true;
    } else {
      const OK = t('Apply');
      const choice = await vscode.window.showInformationMessage(
        t('Apply the patch?'),
        { modal: true, detail: [...lines, '', t('The changes go to the working tree (nothing is committed).')].join('\n') },
        OK,
      );
      if (choice !== OK) return;
    }
    await runInRepos(this.manager, {
      title: t('Apply Patch'),
      repos: [...byRepo.keys()],
      continueAfterConflict: true,
      run: async (repo) => {
        const text = texts.get(repo)!;
        if (threeWay && failing.has(repo)) {
          await repo.git.applyPatch(text, 'threeWay');
          return t('applied with 3-way merge');
        }
        await repo.git.applyPatch(text, 'apply');
        return t('{0} file(s)', byRepo.get(repo)!.length);
      },
    });
  }
}
