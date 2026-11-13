// Grupos de repos (p. ej. "front": mftheme, mflogin): con un grupo activo, MultiGit trabaja solo con
// sus repos. Puro, sin `vscode`.

/** `multigit.repoGroups`: nombre del grupo → nombres de repo (o patrones con `*`). */
export type RepoGroups = Record<string, string[]>;

function matches(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** Repos del grupo, en el orden recibido. Sin grupo (o grupo inexistente o vacío): todos. */
export function filterByGroup<R extends { name: string }>(repos: readonly R[], groups: RepoGroups, active: string | undefined): R[] {
  const patterns = active ? groups[active] : undefined;
  if (!patterns?.length) return [...repos];
  const selected = repos.filter((r) => patterns.some((p) => matches(r.name, p)));
  return selected.length ? selected : [...repos];
}

/** ¿El grupo activo existe y deja algún repo? (si no, se trabaja con todos). */
export function isGroupEffective(repos: ReadonlyArray<{ name: string }>, groups: RepoGroups, active: string | undefined): boolean {
  const patterns = active ? groups[active] : undefined;
  return !!patterns?.length && repos.some((r) => patterns.some((p) => matches(r.name, p)));
}

/** Limpia lo que venga de la configuración (valores que no son listas de textos). */
export function normalizeGroups(value: unknown): RepoGroups {
  if (!value || typeof value !== 'object') return {};
  const out: RepoGroups = {};
  for (const [name, list] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(list)) out[name] = list.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  }
  return out;
}
