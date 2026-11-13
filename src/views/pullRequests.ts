// Create Pull Requests…: un PR por repo con la misma rama, hacia la misma rama destino. En GitHub se
// crea por la API (con la cuenta de GitHub de VS Code); en GitLab, Bitbucket y Azure DevOps se abre la
// página de creación con las ramas, el título y la descripción ya puestos.
import * as vscode from 'vscode';
import { errorText } from '../git/MultiRepoRunner';
import {
  createGitHubPullRequest,
  defaultTitle,
  newPullRequestUrl,
  parseRemoteUrl,
  type FetchLike,
  type Provider,
  type RemoteInfo,
} from '../git/pullRequests';
import type { Repo, RepoManager } from '../git/RepoManager';
import { t } from '../i18n';

interface Candidate {
  repo: Repo;
  branch: string;
  remote: string;
  remoteInfo?: RemoteInfo;
  defaultBranch?: string;
  /** Rama sin publicar o con commits sin subir. */
  notPushed: boolean;
}

interface Result {
  repo: Repo;
  url?: string;
  state: 'created' | 'existing' | 'opened' | 'failed';
  error?: string;
}

const PROVIDERS: Provider[] = ['github', 'gitlab', 'bitbucket', 'azure'];
const PROVIDER_LABEL: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps' };

function config() {
  const c = vscode.workspace.getConfiguration('multigit.pullRequests');
  return {
    providers: c.get<Record<string, string>>('providers', {}),
    draft: c.get<boolean>('draft', false),
    useGitHubApi: c.get<boolean>('useGitHubApi', true),
  };
}

async function describe(repo: Repo, providers: Record<string, string>): Promise<Candidate | undefined> {
  const branch = repo.status?.branch;
  if (!branch) return undefined;
  const upstream = repo.status?.upstream ?? null;
  const remotes = (await repo.git.exec(['remote']).catch(() => '')).split('\n').filter(Boolean);
  const remote = upstream?.split('/')[0] ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remote) return undefined;
  const url = await repo.git.remoteUrl(remote).catch(() => '');
  return {
    repo,
    branch,
    remote,
    remoteInfo: parseRemoteUrl(url, providers),
    defaultBranch: await repo.git.remoteDefaultBranch(remote),
    notPushed: !upstream || (repo.status?.ahead ?? 0) > 0,
  };
}

export async function createPullRequests(manager: RepoManager, openPush: (repos: readonly Repo[]) => Promise<void>, repos: readonly Repo[] = manager.all): Promise<void> {
  const cfg = config();
  const candidates = (
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: reading remotes…') }, () =>
      Promise.all(repos.map((r) => describe(r, cfg.providers))),
    )
  ).filter((c): c is Candidate => !!c);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(t('MultiGit: no repository has a branch with a remote.'));
    return;
  }

  // 1. Rama destino: las ramas por defecto de los remotos y las favoritas.
  const counts = new Map<string, number>();
  for (const c of candidates) if (c.defaultBranch) counts.set(c.defaultBranch, (counts.get(c.defaultBranch) ?? 0) + 1);
  const options = [...new Set([...[...counts].sort((a, b) => b[1] - a[1]).map(([b]) => b), ...manager.favoriteBranches])];
  const OTHER = '\0other';
  const pickedTarget = await vscode.window.showQuickPick(
    [
      ...options.map((b) => ({ label: `$(git-branch) ${b}`, description: counts.get(b) ? t('default branch in {0} repo(s)', counts.get(b)) : '', branch: b })),
      { label: `$(edit) ${t('Other branch…')}`, branch: OTHER },
    ],
    { title: t('Create Pull Requests (1/3): target branch'), placeHolder: t('Branch the pull requests will be merged into') },
  );
  if (!pickedTarget) return;
  const target =
    pickedTarget.branch === OTHER
      ? (await vscode.window.showInputBox({ title: t('Target branch'), validateInput: (v) => (v.trim() ? undefined : t('Type a name')) }))?.trim()
      : pickedTarget.branch;
  if (!target) return;

  // 2. Repos con commits respecto a la rama destino.
  const withCommits = (
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: comparing with {0}…', target) }, () =>
      Promise.all(
        candidates
          .filter((c) => c.branch !== target)
          .map(async (c) => {
            const base = `${c.remote}/${target}`;
            if (!(await c.repo.git.revisionExists(base))) return { c, subjects: [] as string[], missing: true };
            return { c, subjects: await c.repo.git.subjects(`${base}..${c.branch}`).catch(() => []), missing: false };
          }),
      ),
    )
  ).filter((x) => x.subjects.length > 0);
  if (withCommits.length === 0) {
    void vscode.window.showInformationMessage(t("MultiGit: no repository has commits to merge into '{0}'.", target));
    return;
  }
  const notPushed = withCommits.filter((x) => x.c.notPushed).map((x) => x.c.repo);
  if (notPushed.length) {
    const PUSH = t('Push…');
    const choice = await vscode.window.showWarningMessage(
      t('Push the branch first in {0} repo(s)?', notPushed.length),
      { modal: true, detail: t('The pull request uses the branch on the server. Not published or with commits not pushed:\n{0}', notPushed.map((r) => `  • ${r.name}`).join('\n')) },
      PUSH,
    );
    if (choice === PUSH) await openPush(notPushed);
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    withCommits.map((x) => ({
      label: `$(repo) ${x.c.repo.name}`,
      description: `${x.c.branch} → ${target} · ${t('{0} commit(s)', x.subjects.length)}`,
      detail: x.c.remoteInfo ? `${x.c.remoteInfo.provider ? PROVIDER_LABEL[x.c.remoteInfo.provider] : t('unknown provider')} · ${x.c.remoteInfo.host}/${x.c.remoteInfo.path}` : t('the remote URL is not recognized'),
      picked: !!x.c.remoteInfo,
      x,
    })),
    { title: t('Create Pull Requests (2/3): repositories'), canPickMany: true, ignoreFocusOut: true },
  );
  if (!chosen?.length) return;
  const selected = chosen.map((i) => i.x).filter((x) => x.c.remoteInfo);

  // Hosts propios sin proveedor conocido: se pregunta una vez y se guarda.
  for (const host of [...new Set(selected.filter((x) => !x.c.remoteInfo!.provider).map((x) => x.c.remoteInfo!.host))]) {
    const p = await vscode.window.showQuickPick(
      PROVIDERS.map((id) => ({ label: PROVIDER_LABEL[id], id })),
      { title: t("Which service is '{0}'?", host), placeHolder: t('It is saved in multigit.pullRequests.providers') },
    );
    if (!p) return;
    const providers = { ...config().providers, [host]: p.id };
    await vscode.workspace.getConfiguration('multigit.pullRequests').update('providers', providers, vscode.ConfigurationTarget.Global);
    for (const x of selected) if (x.c.remoteInfo!.host === host) x.c.remoteInfo = { ...x.c.remoteInfo!, provider: p.id };
  }

  // 3. Título y descripción (los mismos para todos).
  const branches = [...new Set(selected.map((x) => x.c.branch))];
  const title = (
    await vscode.window.showInputBox({
      title: t('Create Pull Requests (3/3): title'),
      value: defaultTitle(branches[0]!, selected.flatMap((x) => x.subjects)),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : t('Type a title')),
    })
  )?.trim();
  if (!title) return;
  const body = await vscode.window.showInputBox({ title: t('Description (optional)'), prompt: t('Same description for all the pull requests'), ignoreFocusOut: true });
  if (body === undefined) return;

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('MultiGit: creating pull requests'), cancellable: false },
    async (progress) => {
      const out: Result[] = [];
      let token: string | undefined;
      for (const [i, { c }] of selected.entries()) {
        progress.report({ message: `${i + 1}/${selected.length} ${c.repo.name}`, increment: 100 / selected.length });
        const remote = c.remoteInfo!;
        try {
          if (remote.provider === 'github' && remote.host === 'github.com' && cfg.useGitHubApi) {
            token ??= (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken;
            const pr = await createGitHubPullRequest(fetch as unknown as FetchLike, token, remote, { source: c.branch, target, title, body, draft: cfg.draft });
            out.push({ repo: c.repo, url: pr.url, state: pr.existing ? 'existing' : 'created' });
          } else {
            const url = newPullRequestUrl(remote, c.branch, target, title, body);
            if (!url) throw new Error(t('unknown provider'));
            await vscode.env.openExternal(vscode.Uri.parse(url, true));
            out.push({ repo: c.repo, url, state: 'opened' });
          }
        } catch (error) {
          out.push({ repo: c.repo, state: 'failed', error: errorText(error) });
        }
      }
      return out;
    },
  );
  await showResults(results);
}

/** Resumen: cada repo con su PR (clic → abrirlo). */
async function showResults(results: readonly Result[]): Promise<void> {
  const icon = { created: '$(pass)', existing: '$(git-pull-request)', opened: '$(link-external)', failed: '$(error)' };
  const text = {
    created: t('created'),
    existing: t('already existed'),
    opened: t('opened in the browser to finish'),
    failed: t('failed'),
  };
  const items = results.map((r) => ({
    label: `${icon[r.state]} ${r.repo.name}`,
    description: text[r.state],
    detail: r.error ?? r.url,
    url: r.url,
  }));
  const qp = vscode.window.createQuickPick<(typeof items)[number]>();
  qp.title = t('Pull requests');
  qp.placeholder = t('Choose one to open it');
  qp.items = items;
  qp.onDidAccept(() => {
    const url = qp.selectedItems[0]?.url;
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url, true));
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
