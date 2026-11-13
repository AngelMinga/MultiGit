// Conflicts, como el diálogo de IntelliJ: por repo, "Merging branch X into branch Y" y la tabla de
// archivos en conflicto con las columnas Yours / Theirs. Al pasar el ratón aparece "Accept" en cada
// lado; con varios elegidos (Ctrl/⌘ + clic) se aceptan juntos. Doble clic o Resolve Manually → merge editor.
import { useEffect, useMemo, useState } from 'react';
import type { ConflictRepoView, ConflictSide, ConflictsState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

const key = (repoId: string, p: string) => `${repoId}\0${p}`;

const sideLabel = (s: ConflictSide) => (s === 'deleted' ? t('Deleted') : s === 'added' ? t('Added') : t('Modified'));

export function ConflictsDialog() {
  const [state, setState] = useState<ConflictsState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'conflicts/state') return;
        setState(m.payload);
        // Quitar de la selección lo que ya no está en conflicto.
        const alive = new Set(m.payload.repos.flatMap((r) => r.files.map((f) => key(r.id, f.path))));
        setSelected((prev) => new Set([...prev].filter((k) => alive.has(k))));
      }),
    [],
  );

  const unresolved = useMemo(() => (state?.repos ?? []).reduce((n, r) => n + r.files.length, 0), [state]);
  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const busy = state.busy;
  const canFinish = !busy && unresolved === 0 && state.repos.some((r) => r.operation);
  const selectedRefs = state.repos.flatMap((r) => r.files.filter((f) => selected.has(key(r.id, f.path))).map((f) => ({ repo: r, file: f })));
  const single = selectedRefs.length === 1 ? selectedRefs[0] : undefined;

  const accept = (side: 'ours' | 'theirs', refs = selectedRefs) => {
    const byRepo = new Map<string, string[]>();
    for (const { repo, file } of refs) byRepo.set(repo.id, [...(byRepo.get(repo.id) ?? []), file.path]);
    for (const [repoId, paths] of byRepo) post({ type: 'conflicts/accept', payload: { repoId, paths, side } });
  };
  const open = (repoId: string, p: string) => post({ type: 'conflicts/open', payload: { repoId, path: p } });
  const click = (e: React.MouseEvent, k: string) =>
    setSelected((prev) => {
      if (!(e.metaKey || e.ctrlKey)) return new Set([k]);
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="conflicts">
      <div className="pane-toolbar cf-toolbar">
        <strong>{t('Conflicts')}</strong>
        {unresolved ? (
          <span className="muted small">{t('{0} unresolved file(s)', unresolved)}</span>
        ) : (
          <span className="cf-done small">✓ {t('All conflicts have been resolved')}</span>
        )}
        <span className="spacer" />
        <button className="secondary" disabled={busy || !selectedRefs.length} onClick={() => accept('ours')} title={t('Keep your version of the selected files')}>
          {t('Accept Yours')}
        </button>
        <button className="secondary" disabled={busy || !selectedRefs.length} onClick={() => accept('theirs')} title={t('Keep their version of the selected files')}>
          {t('Accept Theirs')}
        </button>
      </div>
      <div className="cf-body">
        {state.repos.length === 0 && <div className="muted pad">{t('There are no conflicts.')}</div>}
        {state.repos.map((r) => (
          <RepoTable
            key={r.id}
            repo={r}
            busy={busy}
            selected={selected}
            open={!collapsed.has(r.id)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(r.id)) next.delete(r.id);
                else next.add(r.id);
                return next;
              })
            }
            onClick={click}
            onOpen={open}
            onAccept={(file, side) => accept(side, [{ repo: r, file }])}
          />
        ))}
      </div>
      <footer className="push-footer">
        <span className="muted small">{t('Double-click a file to resolve it in the merge editor.')}</span>
        <span className="spacer" />
        <button className="secondary" onClick={() => post({ type: 'conflicts/close', payload: {} })}>
          {t('Close')}
        </button>
        {unresolved > 0 && (
          <button className="primary" disabled={busy || !single} onClick={() => single && open(single.repo.id, single.file.path)}>
            {t('Resolve Manually')}
          </button>
        )}
        <button
          className={unresolved === 0 ? 'primary' : 'secondary'}
          disabled={!canFinish}
          onClick={() => post({ type: 'conflicts/finish', payload: {} })}
          title={t('Continue the merge/rebase in the repositories without conflicts')}
        >
          {t('Accept and Finish')}
        </button>
      </footer>
    </div>
  );
}

function RepoTable(props: {
  repo: ConflictRepoView;
  busy: boolean;
  selected: Set<string>;
  open: boolean;
  onToggle: () => void;
  onClick: (e: React.MouseEvent, k: string) => void;
  onOpen: (repoId: string, path: string) => void;
  onAccept: (file: ConflictRepoView['files'][number], side: 'ours' | 'theirs') => void;
}) {
  const { repo } = props;
  return (
    <section className="cf-repo">
      <div className="cf-title">
        <span className="dot" style={{ background: `var(--vscode-multigit-repo${repo.colorIndex})` }} />
        <strong>{repo.name}</strong>
        <span className="muted">— {repo.title}</span>
      </div>
      <table className="cf-table">
        <thead>
          <tr>
            <th />
            <th title={repo.yours}>{t('Yours ({0})', repo.yours)}</th>
            <th title={repo.theirs}>{t('Theirs ({0})', repo.theirs)}</th>
          </tr>
        </thead>
        <tbody>
          {repo.files.length > 0 && (
            <tr className="cf-group" onClick={props.onToggle}>
              <td colSpan={3}>
                <span className="twisty">{props.open ? '▾' : '▸'}</span> <span className="cf-unresolved">−</span> <strong>{t('Unresolved')}</strong>{' '}
                <span className="muted small">{t('{0} file(s)', repo.files.length)}</span>
              </td>
            </tr>
          )}
          {props.open &&
            repo.files.map((f) => {
              const k = key(repo.id, f.path);
              const slash = f.path.lastIndexOf('/');
              return (
                <tr
                  key={k}
                  className={`cf-row${props.selected.has(k) ? ' selected' : ''}`}
                  onClick={(e) => props.onClick(e, k)}
                  onDoubleClick={() => props.onOpen(repo.id, f.path)}
                  title={f.path}
                >
                  <td className="cf-file">
                    <span className="cf-name">{f.path.slice(slash + 1)}</span>
                    {f.blocks > 0 && <span className="cf-blocks small">{t('{0} conflict(s)', f.blocks)}</span>}
                    <span className="muted small">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
                  </td>
                  {(['ours', 'theirs'] as const).map((side) => (
                    <td key={side} className="cf-side">
                      <span>{sideLabel(side === 'ours' ? f.yours : f.theirs)}</span>
                      <button
                        className="secondary cf-accept"
                        disabled={props.busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onAccept(f, side);
                        }}
                      >
                        {t('Accept')}
                      </button>
                    </td>
                  ))}
                </tr>
              );
            })}
          {repo.resolved.length > 0 && (
            <tr className="cf-group cf-group-done">
              <td colSpan={3}>
                <span className="cf-done">✓</span> <strong>{t('Resolved files')}</strong> <span className="muted small">{t('{0} file(s)', repo.resolved.length)}</span>
                {repo.files.length === 0 && repo.operation && <span className="muted small"> · {t('Accept and Finish to continue the {0}', repo.operation)}</span>}
              </td>
            </tr>
          )}
          {repo.resolved.map((f) => {
            const slash = f.path.lastIndexOf('/');
            return (
              <tr key={`ok:${f.path}`} className="cf-row cf-row-done" onDoubleClick={() => props.onOpen(repo.id, f.path)} title={f.path}>
                <td className="cf-file">
                  <span className="cf-name">{f.path.slice(slash + 1)}</span>
                  {f.blocks > 0 && <span className="cf-blocks cf-blocks-done small">{`${f.blocks}/${f.blocks}`}</span>}
                  <span className="muted small">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
                </td>
                <td className="cf-side muted">{t('Resolved')}</td>
                <td className="cf-side muted">{t('Resolved')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
