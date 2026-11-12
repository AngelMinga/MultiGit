import { useEffect, useState } from 'react';
import type { WebviewKind } from '../../src/webview/protocol';
import { onHostMessage, post } from './vscode';

export function App() {
  const [kind, setKind] = useState<WebviewKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onHostMessage((message) => {
      switch (message.type) {
        case 'init':
          setKind(message.payload.kind);
          break;
        case 'error':
          setError(message.payload.message);
          break;
      }
    });
    post({ type: 'ready', payload: {} });
    return unsubscribe;
  }, []);

  return (
    <main className="app">
      <h1>MultiGit</h1>
      <p className="muted">{kind ? `Panel: ${kind}` : 'Esperando al host…'}</p>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
