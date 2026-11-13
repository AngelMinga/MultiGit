// Manage Remotes (como IntelliJ): leer los remotes de un repo y la plantilla de URL para añadir un
// remote a todos los repos a la vez. Puro, sin `vscode`.

export interface RemoteEntry {
  name: string;
  /** URL de fetch. */
  url: string;
  /** URL de push, si es distinta. */
  pushUrl?: string;
}

/** Parsea `git remote -v`: "origin\thttps://… (fetch)" / "(push)". */
export function parseRemotes(output: string): RemoteEntry[] {
  const byName = new Map<string, RemoteEntry>();
  for (const line of output.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const [, name = '', url = '', kind] = m;
    const entry = byName.get(name) ?? { name, url };
    if (kind === 'fetch') entry.url = url;
    else if (url !== entry.url) entry.pushUrl = url;
    byName.set(name, entry);
  }
  // Si push se leyó antes que fetch, pushUrl puede coincidir con la de fetch.
  for (const e of byName.values()) if (e.pushUrl === e.url) delete e.pushUrl;
  return [...byName.values()];
}

/** Nombre de remote válido (como los que acepta git). */
export function isValidRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith('.lock') && !name.includes('..');
}

/**
 * Plantilla de URL a partir de la de un repo: su nombre se cambia por `{repo}`
 * (`https://git/x/mftheme.git` → `https://git/x/{repo}.git`). undefined si la URL no contiene el nombre.
 */
export function urlTemplate(url: string, repoName: string): string | undefined {
  const i = url.lastIndexOf(repoName);
  return i < 0 ? undefined : `${url.slice(0, i)}{repo}${url.slice(i + repoName.length)}`;
}

/** URL de un repo a partir de la plantilla. */
export function fromTemplate(template: string, repoName: string): string {
  return template.replace(/\{repo\}/g, repoName);
}
