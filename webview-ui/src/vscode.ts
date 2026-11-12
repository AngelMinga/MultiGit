// Puente tipado con el extension host. `acquireVsCodeApi` solo puede llamarse una vez.
import type { HostMessage, WebviewMessage } from '../../src/webview/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('[no host]', m), getState: () => undefined, setState: () => undefined };

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Estado del webview que VS Code conserva al ocultarlo y recargarlo (preferencias de la vista). */
export function getState<T>(key: string, fallback: T): T {
  const state = (api.getState() as Record<string, unknown> | undefined) ?? {};
  return (state[key] as T | undefined) ?? fallback;
}

export function setState(key: string, value: unknown): void {
  const state = (api.getState() as Record<string, unknown> | undefined) ?? {};
  api.setState({ ...state, [key]: value });
}
