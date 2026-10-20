import { DatabaseSync } from 'node:sqlite';
import { AbsorptionRecorder as AbsorptionCore, hoursOf, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStep, type AbsorptionStore } from '../../shared/absorption.ts';

export { ABSORPTION_WINDOW_MS, GROUP_FLOOR_USD, GROUPS_PER_MINUTE, MAX_ABSORPTION_INSTRUMENTS, type AbsorptionAnswer, type AbsorptionGroup, type AbsorptionMinute } from '../../shared/absorption.ts';

type GroupRow = { inst: string; t0: number; side: string; price: number; steps: string };
type MinuteRow = { inst: string; t: number; n: number; mean: number; m2: number; floor: number };

/** Steps as stored: rows of five finite numbers, credits falling; anything else is not a group. */
function stepsOf(text: string): AbsorptionStep[] | null {
  try { return validSteps(JSON.parse(text)); } catch { return null; }
}
function validSteps(steps: unknown): AbsorptionStep[] | null {
  if (!Array.isArray(steps) || !steps.length) return null;
  for (const s of steps) if (!Array.isArray(s) || s.length !== 5 || !s.every(x => typeof x === 'number' && Number.isFinite(x))) return null;
  return steps as AbsorptionStep[];
}
const asGroup = (row: GroupRow): AbsorptionGroup | null => {
  const steps = stepsOf(row.steps);
  return steps && (row.side === 'buy' || row.side === 'sell') ? { id: row.inst, side: row.side, price: row.price, t0: row.t0, steps } : null;
};
/**
 * An hour's groups read as one text (`readHour`): the groups whose steps are well formed, as the rows give them; null when the text is not
 * the list it should be (a stored value that is not what this code writes), and the hour is then read a row at a time.
 */
function groupsOfText(id: string, text: string | null): AbsorptionGroup[] | null {
  if (text === null) return [];
  let list: unknown;
  try { list = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const groups: AbsorptionGroup[] = [];
  for (const item of list as unknown[]) {
    if (!Array.isArray(item) || item.length !== 4) return null;
    const [t0, side, price, raw] = item as [unknown, unknown, unknown, unknown], steps = validSteps(raw);
    if (typeof t0 !== 'number' || typeof price !== 'number' || (side !== 0 && side !== 1)) return null;
    if (steps) groups.push({ id, side: side ? 'sell' : 'buy', price, t0, steps });
  }
  return groups;
}
const asMinute = (row: MinuteRow): AbsorptionMinute => ({ id: row.inst, t: row.t, n: row.n, mean: row.mean, m2: row.m2, floor: row.floor });
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');
const HOUR = 3_600_000;

/** Absorption candidates and window statistics in the history database, next to the depth columns. */
export class SqliteAbsorptionStore implements AbsorptionStore {
  readonly #db: DatabaseSync;
  readonly #hourGroups;
  readonly #hourText;
  readonly #hourMinutes;
  readonly #instruments;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS absorption_groups (inst TEXT NOT NULL, t0 INTEGER NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, peak REAL NOT NULL, steps TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS absorption_groups_t0 ON absorption_groups(t0);
      CREATE INDEX IF NOT EXISTS absorption_groups_inst_t0 ON absorption_groups(inst, t0);
      CREATE TABLE IF NOT EXISTS absorption_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, mean REAL NOT NULL, m2 REAL NOT NULL, floor REAL NOT NULL, PRIMARY KEY (inst, t));`);
    // One row per group: a group found again (trades a venue sent again after a restart) is not drawn twice. A table from before this
    // index loses its copies first, once: looking for them in a week of BTC held every start for 1.3 s (2026-10-20).
    if (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'absorption_groups_key'").get() === undefined) {
      this.#db.exec(`DELETE FROM absorption_groups WHERE rowid NOT IN (SELECT MIN(rowid) FROM absorption_groups GROUP BY inst, t0, side, price);
        CREATE UNIQUE INDEX IF NOT EXISTS absorption_groups_key ON absorption_groups(inst, t0, side, price);`);
    }
    this.#hourGroups = this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE inst = ? AND t0 >= ? AND t0 < ?');
    // The same groups as one JSON text, [t0, side (1: sell), price, steps] each: handing rows over one at a time cost more than reading them
    // (a cold week of six venues, 430,000 groups: 2.3 s a row at a time, 1.8 s as text). A side that is neither leaves its row out. The price
    // is written by JavaScript (`String` gives a double back to the last bit; SQLite's own text for a REAL can be a bit off at large exponents),
    // where this SQLite can call it (Node 22.13 on); elsewhere the hour is read a row at a time.
    const define = (this.#db as unknown as { function?: (name: string, options: { deterministic: boolean }, run: (value: unknown) => string) => void }).function;
    if (typeof define === 'function') {
      define.call(this.#db, 'hlm_number', { deterministic: true }, value => String(value));
      this.#hourText = this.#db.prepare(`SELECT '[' || group_concat('[' || t0 || ',' || CASE side WHEN 'sell' THEN 1 WHEN 'buy' THEN 0 END || ',' || hlm_number(price) || ',' || steps || ']') || ']' AS groups
        FROM absorption_groups WHERE inst = ? AND t0 >= ? AND t0 < ?`);
    } else this.#hourText = null;
    this.#hourMinutes = this.#db.prepare('SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE inst = ? AND t >= ? AND t < ?');
    // Each instrument found by one step along the index from the one before, not by reading every row.
    this.#instruments = this.#db.prepare(`WITH RECURSIVE i(inst) AS (SELECT MIN(inst) FROM absorption_groups
      UNION ALL SELECT (SELECT MIN(inst) FROM absorption_groups WHERE inst > i.inst) FROM i WHERE i.inst IS NOT NULL) SELECT inst FROM i WHERE inst IS NOT NULL`);
  }
  readHour(id: string, hour: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    const minutes = (this.#hourMinutes.all(id, hour, hour + HOUR) as MinuteRow[]).map(asMinute);
    const groups = this.#hourText ? groupsOfText(id, (this.#hourText.get(id, hour, hour + HOUR) as { groups: string | null }).groups) : null;
    return { groups: groups ?? (this.#hourGroups.all(id, hour, hour + HOUR) as GroupRow[]).flatMap(row => asGroup(row) ?? []), minutes };
  }
  instruments(): string[] { return (this.#instruments.all() as { inst: string }[]).map(row => row.inst); }
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    const groups = (this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE t0 >= ? ORDER BY t0').all(since) as GroupRow[]).flatMap(row => asGroup(row) ?? []);
    const minutes = (this.#db.prepare('SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE t >= ?').all(since) as MinuteRow[]).map(asMinute);
    return { groups, minutes };
  }
  query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number): AbsorptionGroup[] {
    const statement = this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE inst = ? AND t0 >= ? AND t0 < ? AND peak >= ? ORDER BY peak DESC LIMIT ?');
    return ids.flatMap((id, i) => (statement.all(id, from, to, mins[i] ?? Number.MAX_VALUE, limit) as GroupRow[]).flatMap(row => asGroup(row) ?? []));
  }
  async eachHour(ids: readonly string[] | null, mins: readonly number[], from: number, to: number, take: (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) => void): Promise<void> {
    const groups = this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE inst = ? AND t0 >= ? AND t0 < ? AND peak >= ?');
    const minutes = this.#db.prepare('SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE inst = ? AND t >= ? AND t < ? AND floor >= ?');
    const everyGroup = this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE t0 >= ? AND t0 < ?');
    const everyMinute = this.#db.prepare('SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE t >= ? AND t < ?');
    for (const hour of hoursOf(from, to)) {
      const min = (i: number): number => mins[i] ?? Number.MAX_VALUE;
      if (!ids) take((everyGroup.all(hour.from, hour.to) as GroupRow[]).flatMap(row => asGroup(row) ?? []), (everyMinute.all(hour.from, hour.to) as MinuteRow[]).map(asMinute));
      else take(ids.flatMap((id, i) => (groups.all(id, hour.from, hour.to, min(i)) as GroupRow[]).flatMap(row => asGroup(row) ?? [])),
        ids.flatMap((id, i) => (minutes.all(id, hour.from, hour.to, min(i)) as MinuteRow[]).map(asMinute)));
      // The event loop is let go between hours: a week of a busy market is a few hundred thousand rows.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  minutes(ids: readonly string[], from: number, to: number): AbsorptionMinute[] {
    if (!ids.length) return [];
    return (this.#db.prepare(`SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE t >= ? AND t < ? AND inst IN (${placeholders(ids.length)})`).all(from, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER, ...ids) as MinuteRow[]).map(asMinute);
  }
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void {
    const db = this.#db;
    // The first row stands, for groups and minutes alike (see the recorder).
    const group = db.prepare('INSERT OR IGNORE INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)');
    const minute = db.prepare('INSERT OR IGNORE INTO absorption_minutes (inst, t, n, mean, m2, floor) VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const g of groups) group.run(g.id, g.t0, g.side, g.price, peakOf(g), JSON.stringify(g.steps));
      for (const m of minutes) minute.run(m.id, m.t, m.n, m.mean, m.m2, m.floor);
      db.prepare('DELETE FROM absorption_groups WHERE t0 < ?').run(expireBefore);
      db.prepare('DELETE FROM absorption_minutes WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** The absorption recorder persisted in SQLite (`dbPath`), or kept in memory when there is none. */
export class AbsorptionRecorder extends AbsorptionCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqliteAbsorptionStore(dbPath) : null, now); }
}
