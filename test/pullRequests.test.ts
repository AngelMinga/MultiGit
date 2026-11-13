// PRs multi-repo: URLs de remotos, enlaces de creación y API de GitHub (con fetch simulado).
import { describe, expect, it } from 'vitest';
import { createGitHubPullRequest, defaultTitle, newPullRequestUrl, parseRemoteUrl, type FetchLike } from '../src/git/pullRequests';

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/shell.git', 'github', 'github.com', 'acme/shell'],
    ['git@github.com:acme/shell.git', 'github', 'github.com', 'acme/shell'],
    ['ssh://git@gitlab.com:22/grupo/sub/mf-login.git', 'gitlab', 'gitlab.com', 'grupo/sub/mf-login'],
    ['https://bitbucket.org/team/repo', 'bitbucket', 'bitbucket.org', 'team/repo'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'azure', 'dev.azure.com', 'org/proj/_git/repo'],
    ['https://org@dev.azure.com/org/proj/_git/repo', 'azure', 'dev.azure.com', 'org/proj/_git/repo'],
  ])('%s', (url, provider, host, path) => {
    expect(parseRemoteUrl(url)).toMatchObject({ provider, host, path });
  });

  it('host propio: sin proveedor salvo que se configure', () => {
    expect(parseRemoteUrl('http://10.0.0.5/front/shell.git')).toMatchObject({ provider: undefined, scheme: 'http', host: '10.0.0.5' });
    expect(parseRemoteUrl('http://10.0.0.5/front/shell.git', { '10.0.0.5': 'gitlab' })?.provider).toBe('gitlab');
    expect(parseRemoteUrl('/ruta/local/repo')).toBeUndefined();
  });
});

describe('newPullRequestUrl', () => {
  const at = (url: string) => parseRemoteUrl(url, { 'git.empresa.com': 'gitlab' })!;
  it('GitHub compare con título', () => {
    expect(newPullRequestUrl(at('git@github.com:acme/shell.git'), 'feature/ABC-1 x', 'develop', 'ABC-1 Login')).toBe(
      'https://github.com/acme/shell/compare/develop...feature/ABC-1%20x?expand=1&title=ABC-1%20Login',
    );
  });
  it('GitLab merge request (también en servidor propio)', () => {
    const url = newPullRequestUrl(at('https://git.empresa.com/front/shell.git'), 'feature/x', 'develop', 'T', 'cuerpo')!;
    expect(url.startsWith('https://git.empresa.com/front/shell/-/merge_requests/new?')).toBe(true);
    expect(decodeURIComponent(url)).toContain('merge_request[source_branch]=feature/x&merge_request[target_branch]=develop&merge_request[title]=T&merge_request[description]=cuerpo');
  });
  it('Bitbucket y Azure', () => {
    expect(newPullRequestUrl(at('https://bitbucket.org/t/r.git'), 'a', 'b', 'T')).toBe('https://bitbucket.org/t/r/pull-requests/new?source=a&dest=b&title=T');
    expect(newPullRequestUrl(at('git@ssh.dev.azure.com:v3/o/p/r'), 'a', 'b', 'T')).toBe('https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=a&targetRef=b');
  });
});

describe('createGitHubPullRequest', () => {
  const remote = parseRemoteUrl('git@github.com:acme/shell.git')!;
  const pr = { source: 'feature/x', target: 'develop', title: 'T', body: '', draft: false };

  it('crea el PR', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url} ${init.body ?? ''}`);
      return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/acme/shell/pull/7', number: 7 }) };
    };
    expect(await createGitHubPullRequest(fetchFn, 'tok', remote, pr)).toEqual({ url: 'https://github.com/acme/shell/pull/7', number: 7, existing: false });
    expect(calls[0]).toBe('POST https://api.github.com/repos/acme/shell/pulls {"title":"T","head":"feature/x","base":"develop","body":"","draft":false}');
  });

  it('si ya existe, devuelve el abierto', async () => {
    const fetchFn: FetchLike = async (url, init) =>
      init.method === 'POST'
        ? { ok: false, status: 422, json: async () => ({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature/x.' }] }) }
        : { ok: true, status: 200, json: async () => (url.includes('head=acme%3Afeature%2Fx') ? [{ html_url: 'https://github.com/acme/shell/pull/3', number: 3 }] : []) };
    expect(await createGitHubPullRequest(fetchFn, 'tok', remote, pr)).toEqual({ url: 'https://github.com/acme/shell/pull/3', number: 3, existing: true });
  });

  it('otros errores: lanza con el detalle', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 422, json: async () => ({ message: 'Validation Failed', errors: [{ message: 'No commits between develop and feature/x' }] }) });
    await expect(createGitHubPullRequest(fetchFn, 'tok', remote, pr)).rejects.toThrow('GitHub 422: Validation Failed: No commits between develop and feature/x');
  });
});

describe('defaultTitle', () => {
  it('un solo asunto, o la rama legible', () => {
    expect(defaultTitle('feature/x', ['feat: login', 'feat: login'])).toBe('feat: login');
    expect(defaultTitle('feature/ABC-12-nuevo-login', ['a', 'b'])).toBe('ABC-12 nuevo login');
    expect(defaultTitle('fix/menu_lateral', ['a', 'b'])).toBe('Menu lateral');
  });
});
