import { DatabaseSync } from 'node:sqlite';
import { LS_FORMAT, type LsBacking, type LsChange, type LsHeldRecord } from '../../shared/long-short.ts';

/** The most series the file keeps: the long/short cache's own bound with room for the series of a few windows more. */
export const LS_STORE_MAX_SERIES = 96;

/**
 * The long/short cache's series kept across restarts (shared/long-short.ts `LsBacking`), in a file of its own: never the history store, whose
 * budget the readings are not part of. A reading a row, so a read's change is a few rows (the newest stretch read again once a period); a series
 * a row of its stretch and when it was last used, and past `maxSeries` the least recently used go. A write is one transaction, small: the
 * server's loop is not held by it.
 *
 * A change is applied to what the file holds, which must be what the cache held before the read: where it may not be (the series' row is gone,
 * dropped by the bound while the cache kept it, or its last write failed), the series is written whole instead, from the cache's own. A file
 * of another format (`LS_FORMAT`, its `user_version`) is emptied when opened.
 */
export class SqliteLsStore implements LsBacking {
  readonly #db: DatabaseSync;
  readonly #points; readonly #meta; readonly #upsertPoint; readonly #upsertMeta; readonly #touch; readonly #clear; readonly #trim; readonly #oldest; readonly #drop;
  /** Series whose last write failed: written whole next time. */
  readonly #dirty = new Set<string>();
  constructor(path: string, private maxSeries = LS_STORE_MAX_SERIES, private now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS ls_series (key TEXT PRIMARY KEY, from_ms REAL NOT NULL, to_ms REAL NOT NULL, checked REAL NOT NULL, used INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ls_series_used ON ls_series (used);
      CREATE TABLE IF NOT EXISTS ls_points (key TEXT NOT NULL, t INTEGER NOT NULL, long REAL NOT NULL, PRIMARY KEY (key, t)) WITHOUT ROWID;`);
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== LS_FORMAT) {
      this.#db.exec('BEGIN');
      try { this.#db.exec(`DELETE FROM ls_points; DELETE FROM ls_series; PRAGMA user_version = ${LS_FORMAT};`); this.#db.exec('COMMIT'); }
      catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* none open */ } throw error; }
    }
    this.#points = this.#db.prepare('SELECT t, long FROM ls_points WHERE key = ? ORDER BY t');
    this.#meta = this.#db.prepare('SELECT from_ms, to_ms, checked FROM ls_series WHERE key = ?');
    this.#upsertPoint = this.#db.prepare('INSERT INTO ls_points (key, t, long) VALUES (?, ?, ?) ON CONFLICT (key, t) DO UPDATE SET long = excluded.long');
    this.#upsertMeta = this.#db.prepare('INSERT INTO ls_series (key, from_ms, to_ms, checked, used) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET from_ms = excluded.from_ms, to_ms = excluded.to_ms, checked = excluded.checked, used = excluded.used');
    this.#touch = this.#db.prepare('UPDATE ls_series SET used = ? WHERE key = ?');
    this.#clear = this.#db.prepare('DELETE FROM ls_points WHERE key = ?');
    this.#trim = this.#db.prepare('DELETE FROM ls_points WHERE key = ? AND (t < ? OR t > ?)');
    // Past the bound, the least recently used other than the series being written (a clock stepped back, or a tie, would put it among them).
    this.#oldest = this.#db.prepare('SELECT key FROM ls_series WHERE key <> ? ORDER BY used DESC LIMIT -1 OFFSET ?');
    this.#drop = this.#db.prepare('DELETE FROM ls_series WHERE key = ?');
  }

  async load(key: string): Promise<LsHeldRecord | null> {
    const meta = this.#meta.get(key) as { from_ms: number; to_ms: number; checked: number } | undefined;
    if (!meta) return null;
    const points = (this.#points.all(key) as { t: number; long: number }[]).map(row => ({ t: row.t, long: row.long }));
    // Marked used only if that can be written: a read never fails for it.
    try { this.#touch.run(this.now(), key); } catch { /* the bound may drop it a little early */ }
    return { points, from: meta.from_ms, to: meta.to_ms, checked: meta.checked };
  }

  save(key: string, change: LsChange, full: () => LsHeldRecord): void {
    let begun = false;
    try {
      const whole = !change.cleared && (this.#dirty.has(key) || !this.#meta.get(key));
      this.#db.exec('BEGIN'); begun = true;
      if (change.cleared || whole) this.#clear.run(key);
      for (const p of whole ? full().points : change.added) this.#upsertPoint.run(key, p.t, p.long);
      if (change.keep && !whole) this.#trim.run(key, change.keep.first, change.keep.last);
      this.#upsertMeta.run(key, change.from, change.to, change.checked, this.now());
      // The others past the bound (the one being written stays: `maxSeries - 1` others besides it).
      for (const row of this.#oldest.all(key, Math.max(0, this.maxSeries - 1)) as { key: string }[]) { this.#clear.run(row.key); this.#drop.run(row.key); this.#dirty.delete(row.key); }
      this.#db.exec('COMMIT');
      this.#dirty.delete(key);
    } catch (error) {
      // Whatever failed (the meta read, the transaction), the file may now lack this change: the series is written whole next time.
      this.#dirty.add(key);
      if (begun) try { this.#db.exec('ROLLBACK'); } catch { /* none open */ }
      throw error;
    }
  }

  close(): void { this.#db.close(); }
}
