// Askpass de punta a punta: git real pidiendo la contraseña de un remoto HTTP con auth básica.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnswerCache, AskpassServer, classifyPrompt } from '../src/git/askpass';

const run = promisify(execFile);
let dir: string;
let server: AskpassServer;
const asked: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'multigit-askpass-'));
  server = await AskpassServer.start(dir, async (prompt) => {
    asked.push(prompt);
    if (/cancel/.test(prompt)) return undefined;
    return /Username/.test(prompt) ? 'angel' : 'token-123';
  });
});

afterAll(async () => {
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('askpass', () => {
  it('el script devuelve la respuesta del servidor', async () => {
    const env = { ...process.env, ...server.env };
    const { stdout } = await run(server.env.GIT_ASKPASS!, ["Password for 'https://angel@github.com': "], { env });
    expect(stdout).toBe('token-123\n');
    expect(asked.at(-1)).toBe("Password for 'https://angel@github.com': ");
  });

  it('si el usuario cancela, el script sale con error (git aborta la operación)', async () => {
    const env = { ...process.env, ...server.env };
    await expect(run(server.env.GIT_ASKPASS!, ['cancel please'], { env })).rejects.toThrow();
  });

  it('git usa GIT_ASKPASS para pedir usuario y contraseña', async () => {
    // git credential fill pide usuario y contraseña con el askpass cuando no hay helper.
    const env = { ...process.env, ...server.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const child = execFile('git', ['credential', 'fill'], { env });
    child.stdin!.end('protocol=https\nhost=example.com\n\n');
    const out = await new Promise<string>((resolve, reject) => {
      let data = '';
      child.stdout!.on('data', (c) => (data += c));
      child.on('close', (code) => (code === 0 ? resolve(data) : reject(new Error(`exit ${code}`))));
    });
    expect(out).toContain('username=angel');
    expect(out).toContain('password=token-123');
  });

  it('clasifica las preguntas', () => {
    expect(classifyPrompt("Password for 'https://x@github.com': ")).toBe('secret');
    expect(classifyPrompt("Enter passphrase for key '/Users/a/.ssh/id_ed25519': ")).toBe('secret');
    expect(classifyPrompt("Username for 'https://github.com': ")).toBe('username');
    expect(classifyPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe('confirm');
  });

  it('caché de respuestas: expira y no guarda confirmaciones', () => {
    const cache = new AnswerCache(1000);
    cache.set('Password: ', 'x', 0);
    expect(cache.get('Password: ', 500)).toBe('x');
    expect(cache.get('Password: ', 1500)).toBeUndefined();
    cache.set('continue connecting (yes/no)? ', 'yes', 0);
    expect(cache.get('continue connecting (yes/no)? ', 1)).toBeUndefined();
  });
});
