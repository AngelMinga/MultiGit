// Filtro Repo del Git Log, como el apartado "Roots" de IntelliJ: cada repo con su color y una casilla.
// Clic en la casilla = añadir/quitar ese repo; clic en el nombre = solo ese repo. `[]` = todos.
import { useEffect, useRef, useState } from 'react';
import type { LogRepoInfo } from '../../../src/webview/protocol';
import { t } from '../i18n';

const color = (r: LogRepoInfo) => `var(--vscode-multigit-repo${r.colorIndex})`;

export function RepoFilter(props: { repos: LogRepoInfo[]; value: string[]; onChange: (repoIds: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { repos } = props;
  // Ids que ya no existen no cuentan.
  const value = props.value.filter((id) => repos.some((r) => r.id === id));
  const all = value.length === 0;
  const isOn = (id: string) => all || value.includes(id);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', () => setOpen(false), { once: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const set = (ids: string[]) => props.onChange(ids.length === 0 || ids.length === repos.length ? [] : ids);
  const toggle = (id: string) => {
    const current = all ? repos.map((r) => r.id) : value;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    // Quitar el último dejaría el log vacío: vuelve a todos.
    set(next.length ? repos.filter((r) => next.includes(r.id)).map((r) => r.id) : []);
  };

  const shown = repos.filter((r) => value.includes(r.id));
  return (
    <div className="repo-filter" ref={box}>
      <button className="repo-filter-btn" title={all ? t('All repositories') : shown.map((r) => r.name).join(', ')} onClick={() => setOpen((v) => !v)}>
        {all ? (
          <>
            <span className="repo-swatches">
              {repos.slice(0, 9).map((r) => (
                <span key={r.id} className="repo-swatch mini" style={{ background: color(r) }} />
              ))}
            </span>
            {t('All')}
          </>
        ) : (
          <>
            <span className="repo-swatches">
              {shown.slice(0, 9).map((r) => (
                <span key={r.id} className="repo-swatch mini" style={{ background: color(r) }} />
              ))}
            </span>
            {shown.length === 1 ? shown[0]!.name : t('{0} repositories', shown.length)}
          </>
        )}
        <span className="caret-down">▾</span>
      </button>
      {open && (
        <div className="menu repo-menu" role="menu">
          <button role="menuitemcheckbox" aria-checked={all} onClick={() => set([])}>
            <span className="menu-check">{all ? '✓' : ''}</span>
            {t('All')}
          </button>
          <div className="menu-sep" />
          <div className="menu-title muted small">Roots</div>
          {repos.map((r) => (
            <div key={r.id} className="repo-item" role="menuitemcheckbox" aria-checked={isOn(r.id)}>
              <span
                className={`repo-check${isOn(r.id) ? ' on' : ''}`}
                style={{ borderColor: color(r), background: isOn(r.id) ? color(r) : 'transparent' }}
                title={t('Add or remove')}
                onClick={() => toggle(r.id)}
              >
                {isOn(r.id) ? '✓' : ''}
              </span>
              <span className="repo-name" title={t('Only this repository')} onClick={() => { set([r.id]); setOpen(false); }}>
                {r.name}
              </span>
            </div>
          ))}
          <div className="menu-sep" />
          <div className="menu-hint muted small">{t('Box: add or remove · Name: only that one')}</div>
        </div>
      )}
    </div>
  );
}
