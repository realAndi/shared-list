import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';

/**
 * One copy of the database a day, keeping the last `keep`. The lists are small
 * enough that a whole copy costs less than any incremental scheme would.
 */
export function startBackups(store: Store, dir: string, keep: number): void {
  if (keep <= 0) return;
  mkdirSync(dir, { recursive: true });

  const run = () => {
    try {
      const path = join(dir, `shared-list-${new Date().toISOString().slice(0, 10)}.db`);
      if (!existsSync(path)) store.backupTo(path);
      const old = readdirSync(dir)
        .filter((name) => /^shared-list-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .sort()
        .slice(0, -keep);
      for (const name of old) rmSync(join(dir, name));
    } catch (error) {
      console.error('Backup failed:', error);
    }
  };

  run();
  // Checked every few hours rather than every 24, so a restart never skips a day.
  setInterval(run, 6 * 3600_000).unref();
}
