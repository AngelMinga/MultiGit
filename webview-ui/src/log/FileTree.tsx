// Archivos de un commit como árbol de carpetas (como el detalle del log de IntelliJ): las cadenas de
// una sola subcarpeta se juntan (`src/utils/translate`), cada carpeta con su número de archivos.
import { useMemo, useState, type ReactElement } from 'react';
import type { PushFile } from '../../../src/webview/protocol';
import { t } from '../i18n';

interface Dir {
  name: string;
  path: string;
  dirs: Dir[];
  files: PushFile[];
  count: number;
}

function buildTree(files: readonly PushFile[]): Dir {
  const root: Dir = { name: '', path: '', dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    dir.count++;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: [], files: [], count: 0 };
        dir.dirs.push(next);
      }
      next.count++;
      dir = next;
    }
    dir.files.push(f);
  }
  // Juntar carpetas con una sola subcarpeta y sin archivos: `src` + `utils` + `translate`.
  const compact = (d: Dir): Dir => {
    let cur = d;
    while (cur.dirs.length === 1 && cur.files.length === 0 && cur !== root) {
      const only = cur.dirs[0]!;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return { ...cur, dirs: cur.dirs.map(compact).sort((a, b) => a.name.localeCompare(b.name)), files: [...cur.files].sort((a, b) => a.path.localeCompare(b.path)) };
  };
  return compact(root);
}

export function FileTree(props: { files: readonly PushFile[]; onOpen: (file: PushFile) => void; depth?: number }) {
  const tree = useMemo(() => buildTree(props.files), [props.files]);
  // Con muchos archivos, las carpetas empiezan cerradas (como IntelliJ).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(props.files.length > 25 ? allDirs(tree) : []));
  const base = props.depth ?? 0;
  const toggle = (p: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const render = (dir: Dir, depth: number): ReactElement[] => [
    ...dir.dirs.flatMap((d) => {
      const open = !collapsed.has(d.path);
      return [
        <li key={`d:${d.path}`} className="row file-row ft-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)}>
          <span className="twisty">{open ? '▾' : '▸'}</span>
          <span className="ft-folder">📁</span>
          <span className="file-name">{d.name}</span>
          <span className="muted small">{t('{0} file(s)', d.count)}</span>
        </li>,
        ...(open ? render(d, depth + 1) : []),
      ];
    }),
    ...dir.files.map((f) => (
      <li
        key={`f:${f.status}:${f.oldPath ?? ''}:${f.path}`}
        className="row file-row"
        style={{ paddingLeft: 8 + depth * 14 + 14 }}
        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        onDoubleClick={() => props.onOpen(f)}
      >
        <span className={`status status-${f.status}`}>{f.status}</span>
        <span className="file-name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
      </li>
    )),
  ];
  return <>{render(tree, base)}</>;
}

function allDirs(d: Dir): string[] {
  return d.dirs.flatMap((x) => [x.path, ...allDirs(x)]);
}
