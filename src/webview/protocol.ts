// Mensajes tipados entre el extension host y los webviews (type + payload).
// Este archivo lo importan ambos lados (`import type` desde webview-ui), así que no debe
// importar `vscode` ni módulos de Node.

/** Paneles webview que existen (se irán agregando: push en la Fase 3, log en la Fase 6). */
export type WebviewKind = 'placeholder';

/** Host → webview. */
export type HostMessage =
  | { type: 'init'; payload: { kind: WebviewKind } }
  | { type: 'error'; payload: { message: string } };

/** Webview → host. */
export type WebviewMessage =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string } };
