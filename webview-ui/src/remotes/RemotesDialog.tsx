// Git Remotes, como el de IntelliJ: repo → sus remotes con la URL. + añade (al repo elegido), − quita,
// ✎ edita (también con doble clic) y "Añadir a todos" usa una plantilla de URL con {repo}.
import { useEffect, useState } from 'react';
import type { RemotesState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

type Selection = { repoId: string; name?: string } | null;

export function RemotesDialog() {
  const [state, setState] = useState<RemotesState | null>(null);
  const [selected, setSelected] = useState<Selection>(null);

  useEffect(() => onHostMessage((m) => m.type === 'remotes/state' && setState(m.payload)), []);
  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const remote = selected?.name ? { repoId: selected.repoId, name: selected.name } : undefined;
  const busy = state.busy;

  return (
    <div className="remotes">
      <div className="pane-toolbar rm-toolbar">
        <button className="icon-btn" title={t('Add Remote')} disabled={busy} onClick={() => post({ type: 'remotes/add', payload: { repoId: selected?.repoId } })}>
          ＋
        </button>
        <button className="icon-btn" title={t('Remove')} disabled={busy || !remote} onClick={() => remote && post({ type: 'remotes/remove', payload: remote })}>
          −
        </button>
        <button className="icon-btn" title={t('Edit')} disabled={busy || !remote} onClick={() => remote && post({ type: 'remotes/edit', payload: remote })}>
          ✎
        </button>
        <span className="mg-sep" />
        <button className="link" disabled={busy} onClick={() => post({ type: 'remotes/addAll', payload: {} })} title={t('Add the same remote to every repository with a URL template')}>
          {t('Add to All Repositories…')}
        </button>
      </div>
      <div className="rm-body">
        <table className="rm-table">
          <thead>
            <tr>
              <th>{t('Name')}</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {state.repos.map((r) => [
              <tr
                key={r.id}
                className={`rm-repo${selected?.repoId === r.id && !selected.name ? ' selected' : ''}`}
                onClick={() => setSelected({ repoId: r.id })}
              >
                <td colSpan={2}>
                  <span className="dot" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} /> <strong>{r.name}</strong>
                  {r.remotes.length === 0 && <span className="muted small"> — {t('no remotes')}</span>}
                </td>
              </tr>,
              ...r.remotes.map((x) => (
                <tr
                  key={`${r.id}:${x.name}`}
                  className={`rm-remote${selected?.repoId === r.id && selected.name === x.name ? ' selected' : ''}`}
                  onClick={() => setSelected({ repoId: r.id, name: x.name })}
                  onDoubleClick={() => post({ type: 'remotes/edit', payload: { repoId: r.id, name: x.name } })}
                  title={x.pushUrl ? `push: ${x.pushUrl}` : x.url}
                >
                  <td className="rm-name">{x.name}</td>
                  <td className="rm-url">
                    {x.url}
                    {x.pushUrl && <span className="muted small"> (push: {x.pushUrl})</span>}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <footer className="push-footer">
        <span className="muted small">{t('Double-click a remote to edit it.')}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => post({ type: 'remotes/close', payload: {} })}>
          OK
        </button>
      </footer>
    </div>
  );
}
