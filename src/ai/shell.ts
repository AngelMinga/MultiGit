// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
import { spawn } from 'node:child_process';
import { t } from './l10n';

export interface ShellResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** Thrown by [run] when the signal aborts the process. */
export class CancelledError extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'CancelledError';
    }
}

export interface RunOptions {
    cwd: string;
    stdin?: string;
    env?: Record<string, string>;
    timeoutSec: number;
    signal?: AbortSignal;
    /** Called with each stdout line as it arrives. */
    onStdoutLine?: (line: string) => void;
}

/**
 * Runs a process and collects its output. Rejects with the spawn error if it can't start (e.g. ENOENT), with
 * [CancelledError] if the signal aborts it, and with a timeout error if it takes longer than `timeoutSec`.
 */
export function run(command: string[], options: RunOptions): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(new CancelledError());
        // On macOS/Linux the process gets its own group, so killing it also kills `claude` started by the login shell.
        const detached = process.platform !== 'win32';
        const child = spawn(command[0]!, command.slice(1), {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            detached,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let pending = '';
        let settled = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            if (!options.onStdoutLine) return;
            pending += chunk;
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                options.onStdoutLine(pending.slice(0, newline).replace(/\r$/, ''));
                pending = pending.slice(newline + 1);
            }
        });
        child.stderr.on('data', (chunk: string) => (stderr += chunk));

        // The process may exit without reading everything (e.g. CLI not found): the exit code reports it.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin ?? '');

        const kill = () => {
            try {
                if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch {
                // Already gone.
            }
        };
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            fn();
        };
        const onAbort = () => {
            kill();
            finish(() => reject(new CancelledError()));
        };
        options.signal?.addEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            kill();
            finish(() => reject(new Error(t('Timed out after {0}s running: {1}', options.timeoutSec, command[0] ?? ''))));
        }, options.timeoutSec * 1000);

        child.on('error', (error) => finish(() => reject(error)));
        child.on('close', (code, signal) => {
            if (pending && options.onStdoutLine) options.onStdoutLine(pending);
            finish(() => resolve({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr }));
        });
    });
}
