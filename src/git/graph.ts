// Grafo de commits: asignación de carriles (lanes). Algoritmo propio, en una sola pasada,
// pensado para el log combinado (commits de varios repos intercalados por fecha).
//
// Idea: cada carril "espera" un commit (el siguiente que debe dibujarse en él). Al llegar a un commit:
//   1. Los carriles que lo esperan convergen en su nodo; el de más a la izquierda se queda con el nodo.
//      Si nadie lo espera, es la punta de una rama y ocupa el primer carril libre.
//   2. El primer padre continúa en el carril del nodo (misma rama, mismo color).
//   3. Cada padre extra (merge, octopus) se une a un carril que ya lo espera o abre uno nuevo.
//   4. Los huecos se compactan hacia la izquierda; las líneas que se mueven se dibujan en diagonal.
// Un padre que no está entre los commits cargados (página siguiente o filtrado) no reserva carril:
// se dibuja un tramo corto hacia abajo ("stub") para que no queden líneas colgando.
// Pensado para que cada fila tenga su propio dibujo y se pueda virtualizar.

export interface GraphInput {
  /** Identificador único del commit (en el log combinado: `repo@hash`). */
  id: string;
  /** Identificadores de los padres, en el mismo espacio que `id`. */
  parents: string[];
  /** Grupo (repo): los colores de rama se reparten por grupo. */
  group: string;
}

/** Tramo de línea dentro de una fila: de arriba o del centro, al centro o abajo. */
export interface GraphLine {
  /** Carril en el extremo de origen. */
  x1: number;
  /** Carril en el extremo de destino. */
  x2: number;
  from: 'top' | 'mid';
  to: 'mid' | 'bottom';
  color: number;
  /** Tramo hacia un padre no cargado. */
  stub?: boolean;
}

export interface GraphRow {
  /** Carril del nodo (el punto del commit). */
  node: number;
  color: number;
  /** El commit es un merge (más de un padre). */
  merge: boolean;
  lines: GraphLine[];
  /** Carriles usados por la fila (para calcular el ancho de la columna). */
  width: number;
}

/** Cantidad de colores de rama (ver `--graph-N` en el CSS del webview). */
export const GRAPH_COLORS = 8;

interface Lane {
  /** Commit que espera este carril. */
  id: string;
  color: number;
}

export function computeGraph(rows: readonly GraphInput[]): { rows: GraphRow[]; maxLanes: number } {
  const known = new Set(rows.map((r) => r.id));
  const colorCounter = new Map<string, number>();
  const nextColor = (group: string) => {
    const n = colorCounter.get(group) ?? groupOffset(group);
    colorCounter.set(group, n + 1);
    return n % GRAPH_COLORS;
  };

  let lanes: Array<Lane | null> = [];
  let maxLanes = 0;
  const out: GraphRow[] = [];

  for (const row of rows) {
    const top = lanes;
    const incoming: number[] = [];
    top.forEach((lane, k) => {
      if (lane?.id === row.id) incoming.push(k);
    });

    // 1. Nodo
    const next: Array<Lane | null> = [...top];
    const node = incoming.length ? incoming[0]! : firstFree(next, 0);
    const color = incoming.length ? top[node]!.color : nextColor(row.group);
    for (const k of incoming) next[k] = null;
    while (next.length <= node) next.push(null);

    // 2 y 3. Padres
    const targets: Array<{ slot: number; color: number } | { stub: true; color: number }> = [];
    row.parents.forEach((parent, i) => {
      if (!known.has(parent)) {
        targets.push({ stub: true, color: i === 0 ? color : nextColor(row.group) });
        return;
      }
      if (i === 0) {
        // La rama continúa en su carril aunque otro carril ya espere al mismo padre:
        // las dos líneas convergen recién en el padre.
        next[node] = { id: parent, color };
        targets.push({ slot: node, color });
        return;
      }
      const existing = next.findIndex((l) => l?.id === parent);
      if (existing >= 0) {
        targets.push({ slot: existing, color: next[existing]!.color });
        return;
      }
      const slot = firstFree(next, node + 1);
      while (next.length <= slot) next.push(null);
      const c = nextColor(row.group);
      next[slot] = { id: parent, color: c };
      targets.push({ slot, color: c });
    });

    // 4. Compactación: posición de cada carril abajo de la fila.
    const map = new Map<number, number>();
    const after: Lane[] = [];
    next.forEach((lane, k) => {
      if (lane) {
        map.set(k, after.length);
        after.push(lane);
      }
    });

    const lines: GraphLine[] = [];
    top.forEach((lane, k) => {
      if (!lane) return;
      if (incoming.includes(k)) lines.push({ x1: k, x2: node, from: 'top', to: 'mid', color: lane.color });
      else lines.push({ x1: k, x2: map.get(k)!, from: 'top', to: 'bottom', color: lane.color });
    });
    for (const t of targets) {
      if ('stub' in t) lines.push({ x1: node, x2: node, from: 'mid', to: 'bottom', color: t.color, stub: true });
      else lines.push({ x1: node, x2: map.get(t.slot)!, from: 'mid', to: 'bottom', color: t.color });
    }

    const width = Math.max(top.length, node + 1, after.length);
    maxLanes = Math.max(maxLanes, width);
    out.push({ node, color, merge: row.parents.length > 1, lines, width });
    lanes = after;
  }

  return { rows: out, maxLanes };
}

function firstFree(lanes: ReadonlyArray<Lane | null>, from: number): number {
  for (let k = from; k < lanes.length; k++) if (!lanes[k]) return k;
  return Math.max(from, lanes.length);
}

/** Color inicial estable por grupo, para que cada repo no empiece siempre con el mismo color. */
function groupOffset(group: string): number {
  let h = 0;
  for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) >>> 0;
  return h % GRAPH_COLORS;
}
