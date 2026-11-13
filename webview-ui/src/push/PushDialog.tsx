// Diálogo Push Commits. El estado vive en el host; aquí solo hay selección y formularios.
import { useEffect, useMemo, useState } from 'react';
import type { PushFile, PushRepoView, PushState, PushTagsMode } from '../../../src/webview/protocol';
import { relativeDate } from '../format';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

const STATE_ICON: Record<string, string> = {
  running: '⏳',
  ok: '✅',
  failed: '❌',
  skipped: '⏭',
  pending: '⏭',
};

interface TargetEdit {
  repoIds: string[];
  remote: string;
  branch: string;
}

export function PushDialog() {
  const [state, setState] = useState<PushState>({ repos: [], busy: true, attempted: false });
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  /** Commit elegido dentro del repo; null = el repo entero (todos sus archivos). */
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [files, setFiles] = useState<{ key: string; files: PushFile[] } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tagsEnabled, setTagsEnabled] = useState(false);
  const [tagsMode, setTagsMode] = useState<Exclude<PushTagsMode, 'none'>>('follow');
  const [menuOpen, setMenuOpen] = useState(false);
  const [edit, setEdit] = useState<TargetEdit | null>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'push/state') setState(m.payload);
        if (m.type === 'push/files') setFiles({ key: `${m.payload.repoId}@${m.payload.hash}`, files: m.payload.files });
      }),
    [],
  );

  const repo = state.repos.find((r) => r.id === selectedRepo) ?? null;
  const checked = state.repos.filter((r) => r.checked && !r.skipReason);
  const pushable = state.repos.filter((r) => !r.skipReason);
  const allChecked = checked.length > 0 && checked.length === pushable.length;
  const withCommits = pushable.filter((r) => r.commits.length > 0);
  const totalCommits = checked.reduce((n, r) => n + r.commits.length, 0);
  const rejected = state.repos.some((r) => r.rejected);
  const tags: PushTagsMode = tagsEnabled ? tagsMode : 'none';
  const allRemotes = useMemo(() => [...new Set(state.repos.flatMap((r) => r.remotes))], [state.repos]);

  /** Elegir un repo (sus archivos) o uno de sus commits (los del commit). */
  const select = (r: PushRepoView, hash: string | null) => {
    setSelectedRepo(r.id);
    setSelectedCommit(hash);
    setFiles(null);
    if (hash) post({ type: 'push/selectCommit', payload: { repoId: r.id, hash } });
    else if (r.commits.length) post({ type: 'push/selectRepo', payload: { repoId: r.id } });
  };

  // Al llegar los datos, elegir el primer repo con commits (como IntelliJ).
  useEffect(() => {
    if (selectedRepo && state.repos.some((r) => r.id === selectedRepo)) return;
    const first = state.repos.find((r) => r.commits.length > 0) ?? state.repos.find((r) => r.checked) ?? state.repos[0];
    if (first) select(first, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.repos, selectedRepo]);

  const runPush = (force: boolean) => {
    setMenuOpen(false);
    post({ type: 'push/run', payload: { repoIds: checked.map((r) => r.id), tags, force } });
  };

  const openEdit = (repos: PushRepoView[]) => {
    const first = repos[0];
    setEdit({
      repoIds: repos.map((r) => r.id),
      remote: first?.remote ?? allRemotes[0] ?? 'origin',
      branch: repos.length === 1 ? first?.remoteBranch ?? '' : '',
    });
  };

  const toggleOpen = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Archivos del panel derecho: del commit elegido o de todo el repo (rango).
  const rangeFiles = files && repo && files.key.startsWith(`${repo.id}@range:`) ? files : null;
  const shownFiles = repo ? (selectedCommit ? (files?.key === `${repo.id}@${selectedCommit}` ? files.files : null) : rangeFiles?.files ?? (repo.commits.length ? null : [])) : [];
  const commit = repo && selectedCommit ? repo.commits.find((c) => c.hash === selectedCommit) : undefined;
  const openDiff = (f: PushFile) => {
    if (!repo?.branch) return;
    if (selectedCommit) post({ type: 'push/openDiff', payload: { repoId: repo.id, hash: selectedCommit, file: f } });
    else if (rangeFiles) post({ type: 'push/openDiff', payload: { repoId: repo.id, hash: repo.branch, file: f, base: rangeFiles.key.slice(`${repo.id}@range:`.length) } });
  };

  return (
    <div className="push">
      <div className="push-main">
        {/* ---------------------------------------------------- repos con sus commits */}
        <section className="pane repos" aria-label={t('Repositories')}>
          <header className="pane-header">
            <label className="check">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={state.busy}
                onChange={(e) => post({ type: 'push/toggle', payload: { repoIds: state.repos.map((r) => r.id), checked: e.target.checked } })}
              />
              <span>{t('Repositories')}</span>
            </label>
            <span className="push-header-tools">
              {withCommits.length > 0 && withCommits.length < pushable.length && (
                <button
                  className="link small"
                  disabled={state.busy}
                  title={t('Check only the repositories that have commits to push')}
                  onClick={() => {
                    post({ type: 'push/toggle', payload: { repoIds: pushable.map((r) => r.id), checked: false } });
                    post({ type: 'push/toggle', payload: { repoIds: withCommits.map((r) => r.id), checked: true } });
                  }}
                >
                  {t('Only with commits ({0})', withCommits.length)}
                </button>
              )}
              <span className="muted">
                {checked.length}/{state.repos.length}
              </span>
            </span>
          </header>
          <ul className="list push-tree">
            {state.repos.flatMap((r) => {
              const open = !collapsed.has(r.id);
              const empty = !r.skipReason && r.commits.length === 0;
              const rows = [
                <li
                  key={r.id}
                  className={`row push-repo${r.id === selectedRepo && !selectedCommit ? ' selected' : ''}${r.skipReason ? ' disabled' : ''}${empty || !r.checked ? ' dim' : ''}`}
                  onClick={() => select(r, null)}
                  title={r.message ?? undefined}
                >
                  <span
                    className="twisty"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.commits.length) toggleOpen(r.id);
                    }}
                  >
                    {r.commits.length ? (open ? '▾' : '▸') : ''}
                  </span>
                  <input
                    type="checkbox"
                    checked={r.checked}
                    disabled={!!r.skipReason || state.busy}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => post({ type: 'push/toggle', payload: { repoIds: [r.id], checked: e.target.checked } })}
                    aria-label={t('Include {0}', r.name)}
                  />
                  <span className="swatch" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} />
                  <span className="push-repo-name">{r.name}</span>
                  {r.skipReason ? (
                    <span className="muted small push-target">{r.skipReason}</span>
                  ) : (
                    <span className="small push-target">
                      <span>{r.branch}</span>
                      <span className="muted"> → </span>
                      <button
                        className="link"
                        title={t('Change target')}
                        disabled={state.busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit([r]);
                        }}
                      >
                        {r.remote} : {r.remoteBranch}
                      </button>
                    </span>
                  )}
                  {r.isNew && <span className="badge new">New</span>}
                  {!r.skipReason && (
                    <span className={`small push-count${r.commits.length ? '' : ' muted'}`}>
                      {r.commits.length ? `↑${r.commits.length}${r.truncated ? '+' : ''}` : t('no commits')}
                    </span>
                  )}
                  {r.state !== 'idle' && <span className="state">{STATE_ICON[r.state]}</span>}
                </li>,
              ];
              if (r.message && r.state !== 'idle' && r.state !== 'running') {
                rows.push(
                  <li key={`${r.id}:msg`} className={`row push-msg small ${r.state === 'failed' ? 'error-text' : 'muted'}`}>
                    {firstLine(r.message)}
                  </li>,
                );
              }
              if (open) {
                for (const c of r.commits) {
                  rows.push(
                    <li
                      key={`${r.id}:${c.hash}`}
                      className={`row push-commit${r.id === selectedRepo && c.hash === selectedCommit ? ' selected' : ''}${r.checked ? '' : ' dim'}`}
                      onClick={() => select(r, c.hash)}
                      title={`${c.shortHash} · ${c.author} · ${relativeDate(c.date)}`}
                    >
                      <span className="subject">{c.subject}</span>
                      <span className="muted small date">{relativeDate(c.date)}</span>
                    </li>,
                  );
                }
              }
              return rows;
            })}
          </ul>
        </section>

        {/* ---------------------------------------------------- archivos */}
        <section className="pane detail" aria-label={t('Files')}>
          <header className="pane-header">
            <span className="push-files-title">
              {!repo
                ? t('Choose a repository or a commit')
                : commit
                  ? `${repo.name} · ${commit.shortHash} ${commit.subject}`
                  : repo.commits.length
                    ? t('{0}: {1} commit(s) to push', repo.name, repo.commits.length)
                    : repo.name}
            </span>
            {shownFiles && shownFiles.length > 0 && <span className="muted small">{t('{0} file(s)', shownFiles.length)}</span>}
          </header>
          <ul className="list">
            {repo && !shownFiles && <li className="muted pad">{t('Loading…')}</li>}
            {repo && shownFiles?.length === 0 && (
              <li className="muted pad">
                {repo.skipReason ?? (repo.isNew ? t('No new commits: only the branch will be created on the remote.') : t('Nothing to push.'))}
              </li>
            )}
            {shownFiles?.map((f) => (
              <li key={`${f.status}:${f.oldPath ?? ''}:${f.path}`} className="row file-row" onDoubleClick={() => openDiff(f)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                <span className={`status status-${f.status}`}>{f.status}</span>
                <span className="file-name">{baseName(f.path)}</span>
                <span className="muted small">{dirName(f.path)}</span>
              </li>
            ))}
          </ul>
          {shownFiles && shownFiles.length > 0 && <div className="muted small pad">{t('Double-click a file to see the diff.')}</div>}
        </section>
      </div>

      {/* ---------------------------------------------------- pie */}
      <footer className="push-footer">
        <label className="check">
          <input type="checkbox" checked={tagsEnabled} onChange={(e) => setTagsEnabled(e.target.checked)} />
          <span>Push tags</span>
        </label>
        <select value={tagsMode} disabled={!tagsEnabled} onChange={(e) => setTagsMode(e.target.value as 'all' | 'follow')}>
          <option value="follow">Current Branch</option>
          <option value="all">All</option>
        </select>
        <button className="secondary" disabled={state.busy || state.repos.length === 0} onClick={() => openEdit(state.repos.filter((r) => !r.skipReason))}>
          Edit all targets
        </button>
        <span className="spacer" />
        {state.busy && <span className="muted">{t('Working…')}</span>}
        {rejected && !state.busy && (
          <button className="secondary" onClick={() => post({ type: 'push/pullAndRetry', payload: { tags } })}>
            {t('Pull and Retry')}
          </button>
        )}
        <button className="secondary" onClick={() => post({ type: 'push/close', payload: {} })}>
          {t('Cancel')}
        </button>
        <div className="split">
          <button className="primary" disabled={state.busy || checked.length === 0} onClick={() => runPush(false)}>
            Push{totalCommits ? ` (${totalCommits})` : ''}
          </button>
          <button
            className="primary caret"
            disabled={state.busy || checked.length === 0}
            aria-label={t('More push options')}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ▾
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => runPush(true)}>
                Force push (with lease)
              </button>
            </div>
          )}
        </div>
      </footer>

      {edit && (
        <EditTargets
          edit={edit}
          remotes={allRemotes}
          single={edit.repoIds.length === 1}
          onCancel={() => setEdit(null)}
          onApply={(e) => {
            post({
              type: 'push/setTarget',
              payload: { repoIds: e.repoIds, remote: e.remote || undefined, branch: e.branch.trim() || undefined },
            });
            setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function EditTargets(props: {
  edit: TargetEdit;
  remotes: string[];
  single: boolean;
  onCancel: () => void;
  onApply: (edit: TargetEdit) => void;
}) {
  const [value, setValue] = useState(props.edit);
  return (
    <div className="overlay" onClick={props.onCancel}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          props.onApply(value);
        }}
      >
        <h2>{props.single ? t('Push target') : t('Target of {0} repositories', props.edit.repoIds.length)}</h2>
        <label>
          Remote
          <select value={value.remote} onChange={(e) => setValue({ ...value, remote: e.target.value })}>
            {props.remotes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Remote branch')}
          <input
            autoFocus
            value={value.branch}
            placeholder={props.single ? '' : t('empty = each repository\'s')}
            onChange={(e) => setValue({ ...value, branch: e.target.value })}
          />
        </label>
        <div className="dialog-buttons">
          <button type="button" className="secondary" onClick={props.onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="primary">
            {t('Apply')}
          </button>
        </div>
      </form>
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? text;
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
