// Wrapper de git para UN repositorio. Es el único lugar que ejecuta procesos git.
// Siempre execFile con un array de argumentos: nunca se arma un string de shell.
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { parseLeftRightCount, parseStatusV2, type AheadBehind, type RepoStatus } from './parsers';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Error de un comando git, con su código de salida y stderr para mostrar al usuario. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitService {
  readonly name: string;

  constructor(
    readonly root: string,
    private readonly gitPath = 'git',
  ) {
    this.name = path.basename(root);
  }

  /** Ejecuta `git <args>` en la raíz del repo y devuelve stdout. */
  exec(args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        [...args],
        {
          cwd: this.root,
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: options.signal,
          windowsHide: true,
          env: {
            ...process.env,
            // Nunca bloquear esperando credenciales en una terminal invisible.
            GIT_TERMINAL_PROMPT: '0',
            // Mensajes en inglés y estables para poder parsearlos.
            LC_ALL: 'C',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            const detail = stderr.trim() || error.message;
            reject(new GitError(`git ${args.join(' ')} falló en ${this.name}: ${detail}`, args, code, stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /** Rama actual, upstream, ahead/behind y contadores de cambios. */
  async getStatus(): Promise<RepoStatus> {
    // --no-optional-locks: no competir por index.lock con la extensión git integrada.
    const out = await this.exec(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']);
    return parseStatusV2(out);
  }

  /** Commits por subir/bajar respecto al upstream. `null` si la rama no tiene upstream. */
  async getAheadBehind(): Promise<AheadBehind | null> {
    try {
      const out = await this.exec(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      return parseLeftRightCount(out);
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }
}
