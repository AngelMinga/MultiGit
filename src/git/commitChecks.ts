// Comprobaciones antes del commit (como las "Commit Checks" de IntelliJ) sobre las líneas que se
// añaden: TODO/FIXME nuevos, marcas de conflicto y posibles secretos. Puro, sin `vscode`.

export type CheckKind = 'todo' | 'conflict' | 'secret' | 'large' | 'error' | 'warning';

export interface CheckFinding {
  kind: CheckKind;
  repo: string;
  /** Ruta relativa al repo. */
  path: string;
  /** Línea (1…) en el archivo nuevo, si aplica. */
  line?: number;
  /** Texto corto para mostrar (la línea, el tamaño o el mensaje del diagnóstico). */
  text: string;
}

export interface AddedLine {
  line: number;
  text: string;
}

export interface ScanOptions {
  todo: boolean;
  conflictMarkers: boolean;
  secrets: boolean;
}

const TODO = /\b(TODO|FIXME|XXX)\b/;
const CONFLICT = /^(<{7}( |$)|={7}$|>{7}( |$))/;

/** Patrones de secretos frecuentes. Se prefiere avisar de más (el usuario puede hacer commit igual). */
const SECRETS: ReadonlyArray<[string, RegExp]> = [
  ['private key', /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic/OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // password = "algo literal" (no variables ni placeholders vacíos).
  ['password', /\b(pass(word)?|passwd|pwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s$<{]{6,}["']/i],
];

/** Revisa las líneas añadidas de un archivo. */
export function scanAddedLines(repo: string, path: string, lines: readonly AddedLine[], options: ScanOptions): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const { line, text } of lines) {
    const short = text.trim().slice(0, 120);
    if (options.conflictMarkers && CONFLICT.test(text)) out.push({ kind: 'conflict', repo, path, line, text: short });
    if (options.todo && TODO.test(text)) out.push({ kind: 'todo', repo, path, line, text: short });
    if (options.secrets) {
      const hit = SECRETS.find(([, re]) => re.test(text));
      if (hit) out.push({ kind: 'secret', repo, path, line, text: `${hit[0]}: ${mask(short)}` });
    }
  }
  return out;
}

/** No mostrar el secreto entero en el aviso. */
function mask(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=]{12,}/g, (m) => `${m.slice(0, 4)}…${m.slice(-2)}`);
}

/**
 * Líneas añadidas por archivo a partir de `git diff -U0` de varios archivos.
 * Clave: ruta nueva (la de `+++ b/…`).
 */
export function addedLinesByFile(diff: string): Map<string, AddedLine[]> {
  const result = new Map<string, AddedLine[]>();
  let current: AddedLine[] | undefined;
  let next = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      const target = row.slice(4);
      if (target === '/dev/null') {
        current = undefined;
        continue;
      }
      const filePath = unquote(target).replace(/^b\//, '');
      current = result.get(filePath) ?? [];
      result.set(filePath, current);
      continue;
    }
    if (row.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      next = Number(header[1]);
      continue;
    }
    if (current && row.startsWith('+')) current.push({ line: next++, text: row.slice(1) });
  }
  return result;
}

/** Rutas con caracteres raros vienen entre comillas y con escapes octales (`"a\303\261o.js"`). */
function unquote(text: string): string {
  if (!text.startsWith('"')) return text;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
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
    } else bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Líneas de un archivo nuevo (todas añadidas). */
export function allLines(text: string): AddedLine[] {
  return text.split('\n').map((t, i) => ({ line: i + 1, text: t.replace(/\r$/, '') }));
}

/** "1.5 MB" */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
