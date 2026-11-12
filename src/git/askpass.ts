// Askpass: cuando git (HTTPS) o ssh necesitan un dato (usuario, contraseña/token, passphrase de la
// clave, confirmar el host), ejecutan GIT_ASKPASS / SSH_ASKPASS. Ese script le pregunta a MultiGit
// por un socket local y MultiGit muestra el cuadro en VS Code. Es lo mismo que hace la extensión git
// integrada; sin esto, con GIT_TERMINAL_PROMPT=0, fetch/pull/push fallan si falta la credencial.
// Puro Node (sin `vscode`) para poder probarlo; la UI se pasa como `ask`.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

/** Pregunta que hace git/ssh. Devuelve la respuesta o `undefined` si el usuario cancela. */
export type AskHandler = (prompt: string) => Promise<string | undefined>;

/** Script que ejecuta git/ssh: lanza el `main` con el Node de VS Code (Electron como Node). */
const SCRIPT_SH = `#!/bin/sh
ELECTRON_RUN_AS_NODE="1" "$MULTIGIT_ASKPASS_NODE" "$MULTIGIT_ASKPASS_MAIN" "$@"
`;

/** Envía la pregunta al servidor de MultiGit y escribe la respuesta en stdout (lo que lee git). */
const MAIN_JS = `const http = require('http');
const prompt = process.argv.slice(2).join(' ');
const req = http.request(
  { socketPath: process.env.MULTIGIT_ASKPASS_HANDLE, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const { answer } = JSON.parse(body);
        if (typeof answer !== 'string') process.exit(1);
        process.stdout.write(answer + '\\n');
        process.exit(0);
      } catch {
        process.exit(1);
      }
    });
  },
);
req.on('error', () => process.exit(1));
req.end(JSON.stringify({ prompt }));
`;

export class AskpassServer {
  private constructor(
    private readonly server: http.Server,
    private readonly handle: string,
    private readonly scriptPath: string,
    private readonly mainPath: string,
    private readonly nodePath: string,
  ) {}

  /**
   * Arranca el servidor y escribe los scripts en `dir`. `nodePath` es el ejecutable con el que se
   * corre el script (en VS Code, `process.execPath` con ELECTRON_RUN_AS_NODE).
   */
  static async start(dir: string, ask: AskHandler, nodePath = process.execPath): Promise<AskpassServer> {
    await fs.mkdir(dir, { recursive: true });
    const scriptPath = path.join(dir, 'askpass.sh');
    const mainPath = path.join(dir, 'askpass-main.js');
    await fs.writeFile(scriptPath, SCRIPT_SH, { mode: 0o755 });
    await fs.chmod(scriptPath, 0o755);
    await fs.writeFile(mainPath, MAIN_JS);

    const id = randomBytes(8).toString('hex');
    const handle =
      process.platform === 'win32' ? `\\\\.\\pipe\\multigit-askpass-${id}` : path.join(os.tmpdir(), `multigit-askpass-${id}.sock`);

    // Una pregunta a la vez (el fetch corre en paralelo en varios repos).
    let queue: Promise<unknown> = Promise.resolve();
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        const run = async () => {
          let answer: string | undefined;
          try {
            const { prompt } = JSON.parse(body) as { prompt?: string };
            answer = await ask(String(prompt ?? ''));
          } catch {
            answer = undefined;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ answer: answer ?? null }));
        };
        queue = queue.then(run, run);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, () => resolve());
    });
    return new AskpassServer(server, handle, scriptPath, mainPath, nodePath);
  }

  /** Variables de entorno para los procesos git (también para ssh, vía SSH_ASKPASS). */
  get env(): Record<string, string> {
    // git ejecuta GIT_ASKPASS con su sh (también en Windows). El ssh nativo de Windows no puede
    // ejecutar un script .sh, así que allí solo se usa para git (HTTPS).
    const ssh =
      process.platform === 'win32'
        ? {}
        : {
            SSH_ASKPASS: this.scriptPath,
            // OpenSSH ≥ 8.4: usar SSH_ASKPASS aunque no haya DISPLAY (no hay terminal).
            SSH_ASKPASS_REQUIRE: 'force',
            ...(process.env.DISPLAY ? {} : { DISPLAY: ':0' }),
          };
    return {
      GIT_ASKPASS: this.scriptPath,
      ...ssh,
      MULTIGIT_ASKPASS_NODE: this.nodePath,
      MULTIGIT_ASKPASS_MAIN: this.mainPath,
      MULTIGIT_ASKPASS_HANDLE: this.handle,
    };
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(this.handle, { force: true });
  }
}

/** Tipo de pregunta, para elegir el cuadro adecuado. */
export type PromptKind = 'secret' | 'username' | 'confirm' | 'text';

export function classifyPrompt(prompt: string): PromptKind {
  if (/\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i.test(prompt)) return 'confirm';
  if (/password|passphrase|token|PIN/i.test(prompt)) return 'secret';
  if (/username/i.test(prompt)) return 'username';
  return 'text';
}

/**
 * Recuerda las respuestas unos minutos (solo en memoria): en un fetch/push de 9 repos al mismo host
 * git pregunta lo mismo 9 veces. Las confirmaciones de host no se recuerdan.
 */
export class AnswerCache {
  private readonly answers = new Map<string, { value: string; expires: number }>();

  constructor(private readonly ttlMs = 3 * 60_000) {}

  get(prompt: string, now = Date.now()): string | undefined {
    const hit = this.answers.get(prompt);
    if (!hit) return undefined;
    if (hit.expires < now) {
      this.answers.delete(prompt);
      return undefined;
    }
    return hit.value;
  }

  set(prompt: string, value: string, now = Date.now()): void {
    if (classifyPrompt(prompt) === 'confirm') return;
    this.answers.set(prompt, { value, expires: now + this.ttlMs });
  }

  /** Olvida una respuesta (p. ej. si la credencial resultó incorrecta). */
  forget(prompt: string): void {
    this.answers.delete(prompt);
  }

  clear(): void {
    this.answers.clear();
  }
}
