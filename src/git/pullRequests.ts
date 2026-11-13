// Pull requests en varios repos: proveedor a partir de la URL del remoto, enlace para crear el PR en
// la web y creación por la API de GitHub. Puro, sin `vscode` (el `fetch` se recibe como parámetro).

export type Provider = 'github' | 'gitlab' | 'bitbucket' | 'azure';

export interface RemoteInfo {
  provider: Provider | undefined;
  /** `https` o `http` (para la web). */
  scheme: string;
  host: string;
  /** Ruta del proyecto sin `.git`: `owner/repo`, `grupo/subgrupo/repo` o `org/project/_git/repo` (Azure). */
  path: string;
}

/** Proveedor por el nombre del host; los propios (GitLab en un servidor de la empresa) se configuran. */
export function providerOf(host: string, configured: Record<string, string> = {}): Provider | undefined {
  const own = configured[host] ?? configured[host.toLowerCase()];
  if (own === 'github' || own === 'gitlab' || own === 'bitbucket' || own === 'azure') return own;
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.ghe.com') || h.startsWith('github.')) return 'github';
  if (h === 'gitlab.com' || h.startsWith('gitlab.')) return 'gitlab';
  if (h === 'bitbucket.org') return 'bitbucket';
  if (h === 'dev.azure.com' || h === 'ssh.dev.azure.com' || h.endsWith('.visualstudio.com')) return 'azure';
  return undefined;
}

/** Parsea https://host/a/b.git, git@host:a/b.git, ssh://git@host:22/a/b.git y las URLs de Azure. */
export function parseRemoteUrl(url: string, configured: Record<string, string> = {}): RemoteInfo | undefined {
  let scheme = 'https';
  let host: string;
  let rest: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
  const full = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
  if (full) {
    scheme = full[1] === 'http' ? 'http' : 'https';
    host = full[2]!;
    rest = full[3]!;
  } else if (scp) {
    host = scp[1]!;
    rest = scp[2]!;
  } else {
    return undefined;
  }
  let pathPart = rest.replace(/\/+$/, '').replace(/\.git$/, '');
  // Azure por SSH: ssh.dev.azure.com:v3/org/project/repo → dev.azure.com/org/project/_git/repo
  if (host === 'ssh.dev.azure.com') {
    const [, org, project, repo] = pathPart.split('/');
    host = 'dev.azure.com';
    pathPart = `${org}/${project}/_git/${repo}`;
  }
  // https://org@dev.azure.com/org/project/_git/repo y https://org.visualstudio.com/project/_git/repo
  if (!pathPart || !pathPart.includes('/')) return undefined;
  return { provider: providerOf(host, configured), scheme, host, path: pathPart };
}

/** Rama para la URL: se codifica todo menos `/`. */
const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, '/');

/** Página para crear el PR (o MR) con las ramas, el título y la descripción ya puestos. */
export function newPullRequestUrl(remote: RemoteInfo, source: string, target: string, title: string, body = ''): string | undefined {
  const base = `${remote.scheme}://${remote.host}/${remote.path}`;
  const q = (params: Record<string, string>) =>
    Object.entries(params)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  switch (remote.provider) {
    case 'github':
      return `${base}/compare/${enc(target)}...${enc(source)}?${q({ expand: '1', title, body })}`;
    case 'gitlab':
      return `${base}/-/merge_requests/new?${q({
        'merge_request[source_branch]': source,
        'merge_request[target_branch]': target,
        'merge_request[title]': title,
        'merge_request[description]': body,
      })}`;
    case 'bitbucket':
      return `${base}/pull-requests/new?${q({ source, dest: target, title })}`;
    case 'azure':
      return `${base}/pullrequestcreate?${q({ sourceRef: source, targetRef: target })}`;
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ API de GitHub

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface CreatedPullRequest {
  url: string;
  number: number;
  /** Ya existía un PR abierto con esas ramas. */
  existing: boolean;
}

function apiBase(remote: RemoteInfo): string {
  // GitHub Enterprise Server usa /api/v3 en su propio host.
  return remote.host === 'github.com' ? 'https://api.github.com' : `${remote.scheme}://${remote.host}/api/v3`;
}

/** Crea el PR por la API; si ya hay uno abierto con esas ramas, devuelve ese. */
export async function createGitHubPullRequest(
  fetchFn: FetchLike,
  token: string,
  remote: RemoteInfo,
  pr: { source: string; target: string; title: string; body: string; draft: boolean },
): Promise<CreatedPullRequest> {
  const [owner, repo] = remote.path.split('/');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const api = `${apiBase(remote)}/repos/${owner}/${repo}/pulls`;
  const res = await fetchFn(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: pr.title, head: pr.source, base: pr.target, body: pr.body, draft: pr.draft }),
  });
  const data = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: Array<{ message?: string }> };
  if (res.ok && data.html_url) return { url: data.html_url, number: data.number ?? 0, existing: false };
  const detail = [data.message, ...(data.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ');
  if (res.status === 422 && /already exists/i.test(detail)) {
    const list = await fetchFn(`${api}?state=open&head=${encodeURIComponent(`${owner}:${pr.source}`)}&base=${encodeURIComponent(pr.target)}`, { method: 'GET', headers });
    const open = (await list.json().catch(() => [])) as Array<{ html_url?: string; number?: number }>;
    if (Array.isArray(open) && open[0]?.html_url) return { url: open[0].html_url, number: open[0].number ?? 0, existing: true };
  }
  throw new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** Título por defecto: el asunto si hay un solo commit; si no, la rama legible (`feature/ABC-1-login` → `ABC-1 login`). */
export function defaultTitle(branch: string, subjects: readonly string[]): string {
  const unique = [...new Set(subjects)];
  if (unique.length === 1) return unique[0]!;
  const last = branch.split('/').pop() ?? branch;
  const ticket = /^([A-Z][A-Z0-9]+-\d+)[-_]?(.*)$/.exec(last);
  const words = (ticket ? ticket[2]! : last).replace(/[-_]+/g, ' ').trim();
  return ticket ? `${ticket[1]} ${words}`.trim() : words.charAt(0).toUpperCase() + words.slice(1);
}
