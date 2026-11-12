import { useEffect, useState } from 'react';
import type { WebviewKind } from '../../src/webview/protocol';
import { CommitBox } from './commit/CommitBox';
import { PushDialog } from './push/PushDialog';
import { onHostMessage, post } from './vscode';

export function App() {
  const [kind, setKind] = useState<WebviewKind | null>(
    (document.body.dataset.kind as WebviewKind | undefined) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onHostMessage((message) => {
      if (message.type === 'init') setKind(message.payload.kind);
      if (message.type === 'error') setError(message.payload.message);
    });
    post({ type: 'ready', payload: {} });
    return unsubscribe;
  }, []);

  return (
    <>
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)} aria-label="Cerrar">
            ✕
          </button>
        </div>
      )}
      {kind === 'push' ? <PushDialog /> : kind === 'commit' ? <CommitBox /> : <p className="muted pad">Cargando…</p>}
    </>
  );
}
