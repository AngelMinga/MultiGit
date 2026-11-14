// Patches (Create Patch / Apply Patch, como IntelliJ). Puro, sin `vscode`.
//
// Un patch de un solo repo usa rutas relativas al repo (el formato normal de git). Uno de varios repos usa
// rutas relativas a la carpeta común, como IntelliJ con un proyecto de varias raíces: `mftheme/src/a.ts`.
// Al aplicar, cada archivo va al repo cuyo prefijo coincide (y se le quita el prefijo).

/** Un archivo dentro del patch: su texto (desde `diff --git`) y sus rutas. */
export interface PatchFile {
  /** Ruta antes (null = archivo nuevo). */
  oldPath: string | null;
  /** Ruta después (null = archivo borrado). */
  newPath: string | null;
  text: string;
}

/** Ruta "visible" de un archivo del patch (la nueva, o la vieja si se borra). */
export function patchPath(f: PatchFile): string {
  return (f.newPath ?? f.oldPath)!;
}

/** Quita las comillas de una ruta de git ("a/x\ty" → a/x<tab>y). */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Pone comillas a una ruta si git las necesitaría. */
function quote(p: string): string {
  return /["\\\t\n]/.test(p) ? `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\n/g, '\\n')}"` : p;
}

/** Ruta de una línea `--- a/x` / `+++ b/x` (null si es /dev/null). */
function markerPath(rest: string, prefix: 'a/' | 'b/'): string | null {
  const raw = unquote(rest.replace(/\t.*$/, '').trim());
  if (raw === '/dev/null') return null;
  return raw.startsWith(prefix) ? raw.slice(2) : raw;
}

/** Divide el patch en archivos. Lo que hay antes del primer `diff --git` (cabecera de correo) se ignora. */
export function parsePatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    // Quitar la firma de format-patch ("-- \n2.43.0") y las líneas vacías del final.
    while (current.length && current[current.length - 1] === '') current.pop();
    const sig = current.lastIndexOf('-- ');
    if (sig >= 0 && current.slice(sig + 1).every((l) => /^\d[\w.]*$|^$/.test(l)) && !current.slice(sig + 1).some((l) => l.startsWith('@@'))) {
      current = current.slice(0, sig);
    }
    files.push(describe(current));
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return files;
}

function describe(lines: string[]): PatchFile {
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let isNew = false;
  let isDeleted = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('@@') || line.startsWith('GIT binary patch') || line.startsWith('diff --git ')) break;
    if (line.startsWith('new file mode')) isNew = true;
    else if (line.startsWith('deleted file mode')) isDeleted = true;
    else if (line.startsWith('rename from ') || line.startsWith('copy from ')) oldPath = unquote(line.replace(/^(rename|copy) from /, ''));
    else if (line.startsWith('rename to ') || line.startsWith('copy to ')) newPath = unquote(line.replace(/^(rename|copy) to /, ''));
    else if (line.startsWith('--- ')) oldPath ??= markerPath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) newPath ??= markerPath(line.slice(4), 'b/');
  }
  if (oldPath === undefined || newPath === undefined) {
    // Sin ---/+++ (cambio de modo, binario o vacío): la ruta sale de `diff --git a/X b/X`.
    const rest = lines[0]!.slice('diff --git '.length);
    let a: string;
    let b: string;
    const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
    if (rest.startsWith('"') || rest.endsWith('"')) {
      a = unquote(quoted?.[1] ?? rest).slice(2);
      b = unquote(quoted?.[2] ?? rest).slice(2);
    } else {
      // a/<p> b/<p>: las dos mitades miden lo mismo (vale aunque la ruta tenga espacios).
      const half = (rest.length - 1) / 2;
      a = rest.slice(2, half);
      b = rest.slice(half + 3);
    }
    oldPath ??= a;
    newPath ??= b;
  }
  if (isNew) oldPath = null;
  if (isDeleted) newPath = null;
  return { oldPath: oldPath ?? null, newPath: newPath ?? null, text: `${lines.join('\n')}\n` };
}

/** Cambia las rutas de un archivo del patch (`map` recibe cada ruta y devuelve la nueva). */
export function remapFile(f: PatchFile, map: (p: string) => string): PatchFile {
  const oldPath = f.oldPath === null ? null : map(f.oldPath);
  const newPath = f.newPath === null ? null : map(f.newPath);
  const a = oldPath ?? newPath!;
  const b = newPath ?? oldPath!;
  let inHeader = true;
  const out = f.text
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => {
      if (i === 0) return `diff --git ${quote(`a/${a}`)} ${quote(`b/${b}`)}`;
      if (!inHeader) return line;
      if (line.startsWith('@@') || line.startsWith('GIT binary patch')) {
        inHeader = false;
        return line;
      }
      if (line.startsWith('--- ') && oldPath !== null) return `--- ${quote(`a/${oldPath}`)}`;
      if (line.startsWith('+++ ') && newPath !== null) return `+++ ${quote(`b/${newPath}`)}`;
      const m = /^(rename|copy) (from|to) /.exec(line);
      if (m) return `${m[0]}${quote((m[2] === 'from' ? oldPath : newPath) ?? '')}`;
      return line;
    });
  return { oldPath, newPath, text: `${out.join('\n')}\n` };
}

/** Patch de varios repos: el de cada repo con sus rutas bajo `dir/` (relativo a la carpeta común). */
export function combinePatches(parts: ReadonlyArray<{ dir: string; patch: string }>): string {
  return parts
    .flatMap(({ dir, patch }) => parsePatch(patch).map((f) => (dir ? remapFile(f, (p) => `${dir}/${p}`).text : f.text)))
    .join('');
}

export interface PatchTarget<R> {
  repo: R;
  /** Carpeta del repo relativa a la carpeta común ('' si no se usa). */
  dir: string;
}

/**
 * Reparte los archivos del patch por repo según el prefijo de su ruta (el más largo que coincida).
 * Los que no tienen prefijo de ningún repo quedan en `unmatched` (patch de un solo repo).
 */
export function assignPatch<R>(files: readonly PatchFile[], targets: ReadonlyArray<PatchTarget<R>>): { byRepo: Map<R, PatchFile[]>; unmatched: PatchFile[] } {
  const sorted = [...targets].filter((t) => t.dir).sort((x, y) => y.dir.length - x.dir.length);
  const byRepo = new Map<R, PatchFile[]>();
  const unmatched: PatchFile[] = [];
  for (const f of files) {
    const p = patchPath(f);
    const target = sorted.find((t) => p.startsWith(`${t.dir}/`) && (f.oldPath === null || f.oldPath.startsWith(`${t.dir}/`)));
    if (!target) {
      unmatched.push(f);
      continue;
    }
    const strip = (x: string) => (x.startsWith(`${target.dir}/`) ? x.slice(target.dir.length + 1) : x);
    byRepo.set(target.repo, [...(byRepo.get(target.repo) ?? []), remapFile(f, strip)]);
  }
  return { byRepo, unmatched };
}

/** Texto de un conjunto de archivos del patch (para `git apply`). */
export function joinPatch(files: readonly PatchFile[]): string {
  return files.map((f) => f.text).join('');
}

/** Nombre de archivo para un patch a partir de un texto (rama, asunto del commit…). */
export function patchFileName(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'changes'}.patch`;
}
