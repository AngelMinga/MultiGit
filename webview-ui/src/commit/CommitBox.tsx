// Caja de commit: mensaje, Amend last commit, Commit y Commit and Push….
import { useEffect, useRef, useState } from 'react';
import type { CommitState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

const DRAFT_KEY = 'multigit.commitDraft';
const OPTIONS_KEY = 'multigit.commitOptions';

/** "Nombre <email>" (como `git commit --author`). */
const AUTHOR_RE = /^[^<>\n]+ <[^<>\s@]+@[^<>\s]+>$/;

export function CommitBox() {
  const [state, setState] = useState<CommitState>({ repos: [], total: 0, summary: '', busy: false, generating: false, prefix: '' });
  const [message, setMessage] = useState(() => readDraft());
  const [amend, setAmend] = useState(false);
  // Opciones del commit (engranaje, como "Commit Options" de IntelliJ). Sign-off y hooks se recuerdan;
  // el autor vale para el próximo commit.
  const [showOptions, setShowOptions] = useState(false);
  const [author, setAuthor] = useState('');
  const [signoff, setSignoff] = useState(() => readOptions().signoff);
  const [runHooks, setRunHooks] = useState(() => readOptions().runHooks);
  const [authors, setAuthors] = useState<{ authors: string[]; me: string }>({ authors: [], me: '' });
  const authorInvalid = author.trim() !== '' && !AUTHOR_RE.test(author.trim());
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** El usuario escribió mientras Claude generaba: no pisar su texto con el streaming. */
  const typedWhileGenerating = useRef(false);
  /** Último prefijo de ticket puesto en la caja (si el usuario lo borra, no se vuelve a poner). */
  const appliedPrefix = useRef('');
  const prefix = useRef('');
  const messageRef = useRef(message);
  messageRef.current = message;
  /** ¿La caja está vacía o solo tiene el prefijo que pusimos? */
  const untouched = (text: string) => !text.trim() || (appliedPrefix.current !== '' && text === appliedPrefix.current);

  const fillPrefix = (next: string) => {
    appliedPrefix.current = next;
    setMessage(next);
  };

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'commit/state') {
          setState(m.payload);
          prefix.current = m.payload.prefix;
          // Caja vacía (o con el prefijo de otra rama): se rellena con el ticket de la rama.
          const current = messageRef.current;
          const empty = !current.trim() && m.payload.prefix !== appliedPrefix.current;
          if ((empty || (current === appliedPrefix.current && current !== m.payload.prefix)) && m.payload.prefix) fillPrefix(m.payload.prefix);
        }
        if (m.type === 'commit/setMessage') setMessage((current) => (untouched(current) ? m.payload.message : current));
        if (m.type === 'commit/requestHistory') post({ type: 'commit/history', payload: { current: messageRef.current } });
        if (m.type === 'commit/partial' && !typedWhileGenerating.current) setMessage(m.payload.text);
        if (m.type === 'commit/replaceMessage') {
          if (!typedWhileGenerating.current) setMessage(m.payload.message);
          typedWhileGenerating.current = false;
        }
        if (m.type === 'commit/done') {
          fillPrefix(prefix.current);
          setAmend(false);
          setAuthor('');
        }
        if (m.type === 'commit/authors') setAuthors(m.payload);
      }),
    [],
  );

  useEffect(() => writeDraft(message), [message]);
  useEffect(() => writeOptions({ signoff, runHooks }), [signoff, runHooks]);

  const canCommit = !state.busy && state.total > 0 && message.trim().length > 0 && !authorInvalid;
  const run = (push: boolean) => {
    if (canCommit) post({ type: 'commit/run', payload: { message, amend, push, options: { author: author.trim() || undefined, signoff, noVerify: !runHooks } } });
  };
  const optionSummary = [author.trim() ? t('Author: {0}', author.trim().replace(/ <.*$/, '')) : '', signoff ? 'Sign-off' : '', runHooks ? '' : t('no hooks')].filter(Boolean);

  const generate = () => {
    typedWhileGenerating.current = false;
    post({ type: 'commit/generate', payload: { current: message } });
  };

  return (
    <div className="commit">
      <div className="commit-toolbar">
        <button
          className="icon-btn"
          title={t('Commit Message History (Ctrl+M)')}
          aria-label={t('Commit Message History')}
          disabled={state.busy}
          onClick={() => post({ type: 'commit/history', payload: { current: message } })}
        >
          <HistoryIcon />
        </button>
        <button
          className={`icon-btn${showOptions || optionSummary.length ? ' active' : ''}`}
          title={t('Commit Options (author, sign-off, Git hooks)')}
          aria-label={t('Commit Options')}
          aria-expanded={showOptions}
          onClick={() => {
            if (!showOptions && !authors.authors.length) post({ type: 'commit/requestAuthors', payload: {} });
            setShowOptions((v) => !v);
          }}
        >
          <GearIcon />
        </button>
        {state.generating ? (
          <button
            className="claude-btn running"
            title={t('Cancel generation')}
            onClick={() => post({ type: 'commit/cancelGenerate', payload: {} })}
          >
            <span className="spinner" /> {t('Generating…')} <span className="muted">{t('Cancel')}</span>
          </button>
        ) : (
          <button
            className="claude-btn"
            title={t('Write the message with Claude from the checked files (⌘G). Click again for another proposal.')}
            disabled={state.busy || state.total === 0}
            onClick={generate}
          >
            <ClaudeIcon /> {t('Generate with Claude')}
          </button>
        )}
      </div>
      <textarea
        ref={textarea}
        className="commit-message"
        placeholder={t('Commit message (⌘Enter to commit)')}
        value={message}
        disabled={state.busy}
        onChange={(e) => {
          if (state.generating) typedWhileGenerating.current = true;
          setMessage(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key.toLowerCase() === 'g' && (e.metaKey || e.ctrlKey) && !state.generating) {
            e.preventDefault();
            generate();
            return;
          }
          if (e.key.toLowerCase() === 'm' && e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            post({ type: 'commit/history', payload: { current: message } });
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            run(e.shiftKey);
          }
        }}
      />
      {showOptions && (
        <div className="commit-advanced">
          <label className="commit-author">
            <span>{t('Author')}</span>
            <input
              list="multigit-authors"
              value={author}
              placeholder={authors.me ? t('{0} (default)', authors.me) : t('Name <email>')}
              className={authorInvalid ? 'invalid' : ''}
              title={authorInvalid ? t('Use "Name <email>"') : t('Commit on behalf of someone else (git commit --author)')}
              disabled={state.busy}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <datalist id="multigit-authors">
              {authors.authors.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label className="check" title={t('Adds "Signed-off-by: <you>" at the end of the message (git commit --signoff)')}>
            <input type="checkbox" checked={signoff} disabled={state.busy} onChange={(e) => setSignoff(e.target.checked)} />
            <span>Sign-off commit</span>
          </label>
          <label className="check" title={t('Unchecked: the pre-commit and commit-msg hooks are skipped (git commit --no-verify)')}>
            <input type="checkbox" checked={runHooks} disabled={state.busy} onChange={(e) => setRunHooks(e.target.checked)} />
            <span>Run Git hooks</span>
          </label>
        </div>
      )}
      {!showOptions && optionSummary.length > 0 && (
        <div className="small muted commit-option-summary" onClick={() => setShowOptions(true)}>
          ⚙ {optionSummary.join(' · ')}
        </div>
      )}
      <div className="commit-options">
      <label className="check">
        <input
          type="checkbox"
          checked={amend}
          disabled={state.busy}
          onChange={(e) => {
            setAmend(e.target.checked);
            if (e.target.checked) post({ type: 'commit/requestLastMessage', payload: {} });
          }}
        />
        <span>Amend last commit</span>
      </label>
        {state.total > 0 && <span className="small commit-counter">{state.summary}</span>}
      </div>
      <div className="commit-summary small muted">
        {state.total === 0
          ? t('Check files in the Changes view.')
          : state.repos.map((r) => (
              <span key={r.name} className="commit-repo">
                <span className="dot" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} />
                {r.name} ({r.count})
              </span>
            ))}
      </div>
      <div className="commit-buttons">
        <button className="primary" disabled={!canCommit} onClick={() => run(false)}>
          {state.busy ? 'Commit…' : amend ? 'Amend' : 'Commit'}
          {state.total ? ` (${state.total})` : ''}
        </button>
        <button className="secondary" disabled={!canCommit} onClick={() => run(true)} title="⌘⇧Enter">
          Commit and Push…
        </button>
      </div>
    </div>
  );
}

function readOptions(): { signoff: boolean; runHooks: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as { signoff?: boolean; runHooks?: boolean };
    return { signoff: saved.signoff === true, runHooks: saved.runHooks !== false };
  } catch {
    return { signoff: false, runHooks: true };
  }
}

function writeOptions(options: { signoff: boolean; runHooks: boolean }): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // sin almacenamiento: las opciones duran mientras la vista esté abierta
  }
}

/** Engranaje (opciones del commit). */
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M9.1 1l.4 1.9c.4.1.8.3 1.1.5l1.7-1 1.3 1.3-1 1.7c.2.3.4.7.5 1.1l1.9.4v1.8l-1.9.4c-.1.4-.3.8-.5 1.1l1 1.7-1.3 1.3-1.7-1c-.3.2-.7.4-1.1.5L9.1 15H7.3l-.4-1.9c-.4-.1-.8-.3-1.1-.5l-1.7 1-1.3-1.3 1-1.7c-.2-.3-.4-.7-.5-1.1L1.4 9.1V7.3l1.9-.4c.1-.4.3-.8.5-1.1l-1-1.7 1.3-1.3 1.7 1c.3-.2.7-.4 1.1-.5L7.3 1h1.8zM8.2 5.5a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z" />
    </svg>
  );
}

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, text);
  } catch {
    // sin almacenamiento: el borrador solo vive mientras la vista esté abierta
  }
}

/** Reloj con flecha (como el ícono de historial de VS Code). */
function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 1.5a6.5 6.5 0 1 1-6.33 8h1.04A5.5 5.5 0 1 0 3.6 4.6L5 6H1.5V2.5l1.4 1.4A6.48 6.48 0 0 1 8 1.5Z" />
      <path d="M7.5 4.5h1v3.3l2.35 1.36-.5.87L7.5 8.4z" />
    </svg>
  );
}

/** Ícono de Claude Commit (el mismo de la extensión Commit Messages for Claude Code). */
function ClaudeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0" y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="13.5" y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" />
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="#D97757" strokeWidth="1.5" />
      <g fill="#D97757">
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(45 8 8)" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(90 8 8)" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(-45 8 8)" />
      </g>
    </svg>
  );
}
