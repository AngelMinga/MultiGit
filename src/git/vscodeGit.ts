// Subconjunto mínimo de la API pública de la extensión integrada `vscode.git` (getAPI(1)).
// Solo declaramos lo que usamos; la definición completa está en
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts (MIT).
import type { Event, Uri } from 'vscode';

export type APIState = 'uninitialized' | 'initialized';

export interface GitRepositoryState {
  readonly onDidChange: Event<void>;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: GitRepositoryState;
}

export interface GitAPI {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitAPI;
}
