// Fetch periódico opcional (multigit.autoFetchMinutes; 0 = desactivado).
import * as vscode from 'vscode';
import type { RepoManager } from './RepoManager';

export class AutoFetcher implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly manager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('multigit.autoFetchMinutes')) this.schedule();
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const minutes = vscode.workspace.getConfiguration('multigit').get<number>('autoFetchMinutes', 0);
    if (!minutes || minutes <= 0) {
      this.log.info('Auto-fetch desactivado.');
      return;
    }
    this.log.info(`Auto-fetch cada ${minutes} min.`);
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // el anterior todavía no termina
    this.running = true;
    try {
      const results = await this.manager.fetchAll();
      const failed = results.filter((r) => r.error).map((r) => r.repo.name);
      this.log.info(`Auto-fetch terminado${failed.length ? ` (falló en: ${failed.join(', ')})` : ''}.`);
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.subscription.dispose();
  }
}
