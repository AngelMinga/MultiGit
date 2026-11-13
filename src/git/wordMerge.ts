// Diff y merge a nivel de palabras para la ventana de merge: resaltar qué palabra cambió dentro de una
// línea (como IntelliJ) y la varita "Resolver conflictos simples" (un conflicto se resuelve solo si cada
// lado cambió palabras distintas). Puro, sin `vscode` ni Node: lo usa también el webview.

/** Palabras, espacios y signos sueltos (unidos dan el texto original). */
export function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu) ?? [];
}

/** Por encima de esto no se compara (el diff es cuadrático): sin resaltado ni varita. */
const MAX_TOKENS = 2000;

/**
 * Pares de índices iguales (a[i] === b[j]) de la subsecuencia común más larga, en orden.
 * `undefined` si los textos son demasiado grandes.
 */
function lcs(a: readonly string[], b: readonly string[]): Array<[number, number]> | undefined {
  // Quitar el principio y el final comunes (lo habitual en cambios pequeños) antes del LCS.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n > MAX_TOKENS || m > MAX_TOKENS) return undefined;
  // dp[i][j] = LCS de a[start+i…] y b[start+j…]
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < start; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      pairs.push([start + i, start + j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** Trozos del texto `b` con `changed` en las palabras que no están en `a` (para resaltarlas). */
export function changedSegments(a: string, b: string): Array<{ text: string; changed: boolean }> | undefined {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const pairs = lcs(ta, tb);
  if (!pairs) return undefined;
  const same = new Set(pairs.map(([, j]) => j));
  const out: Array<{ text: string; changed: boolean }> = [];
  tb.forEach((tok, j) => {
    // Los espacios no se resaltan solos (quedaría ruido); sí si están entre palabras cambiadas.
    const changed = !same.has(j) && !/^\s+$/.test(tok);
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += tok;
    else out.push({ text: tok, changed });
  });
  return out;
}

interface TokenHunk {
  /** Rango de la base [start, end). */
  start: number;
  end: number;
  tokens: string[];
}

/** Cambios de `base` a `other` como hunks sobre la base. */
function hunks(base: readonly string[], other: readonly string[]): TokenHunk[] | undefined {
  const pairs = lcs(base, other);
  if (!pairs) return undefined;
  const out: TokenHunk[] = [];
  let pi = 0;
  let pj = 0;
  for (const [i, j] of [...pairs, [base.length, other.length] as [number, number]]) {
    if (i > pi || j > pj) out.push({ start: pi, end: i, tokens: other.slice(pj, j) });
    pi = i + 1;
    pj = j + 1;
  }
  return out;
}

/**
 * Merge a tres bandas por palabras. Devuelve el texto combinado si los cambios de los dos lados no
 * se solapan ni se tocan (un "conflicto simple"); `undefined` si hay conflicto real o es demasiado grande.
 */
export function mergeWords(base: string, ours: string, theirs: string): string | undefined {
  const tb = tokenize(base);
  const a = hunks(tb, tokenize(ours));
  const b = hunks(tb, tokenize(theirs));
  if (!a || !b) return undefined;
  // Un cambio de cada lado que se solapan o se tocan en la base: conflicto real (no se toca).
  if (a.some((x) => b.some((y) => x.start <= y.end && y.start <= x.end))) return undefined;
  const all = [...a, ...b].sort((x, y) => x.start - y.start || x.end - y.end);
  let out = '';
  let cursor = 0;
  for (const h of all) {
    out += tb.slice(cursor, h.start).join('') + h.tokens.join('');
    cursor = h.end;
  }
  return out + tb.slice(cursor).join('');
}
