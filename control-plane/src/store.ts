import { State } from "./model";
const collections = [
  "items",
  "assets",
  "tombstones",
  "actions",
  "inputs",
  "commands",
] as const;
type Collection = (typeof collections)[number];
/** One bounded record per row: cloud cache quota may exceed SQLite's 2MiB row limit. */
export class StateStore {
  private persisted = new Map<Collection, Map<string, string>>();
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
    );
    for (const name of collections)
      storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS state_${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
      );
  }
  load(): State | null {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM control WHERE id=1")
      .toArray()[0];
    if (!row) return null;
    const header = JSON.parse(row.value) as State & { schemaVersion?: number };
    header.elementExpiries ??= {};
    header.nativeElements ??= {};
    for (const name of collections) {
      const rows = this.storage.sql
        .exec<{ key: string; value: string }>(
          `SELECT key,value FROM state_${name}`,
        )
        .toArray();
      this.persisted.set(
        name,
        new Map(rows.map((row) => [row.key, row.value])),
      );
      if (header.schemaVersion === 2) {
        const records = Object.fromEntries(
          rows.map((row) => [row.key, JSON.parse(row.value)]),
        );
        if (name === "commands")
          header.commands = Object.values(records)
            .sort(
              (a, b) =>
                (a as { position: number }).position -
                (b as { position: number }).position,
            )
            .map((v) => (v as { command: State["commands"][number] }).command);
        else Object.assign(header, { [name]: records });
      }
    }
    return header;
  }
  save(state: State) {
    const header = {
      ...state,
      schemaVersion: 2,
      items: {},
      assets: {},
      tombstones: {},
      actions: {},
      inputs: {},
      commands: [],
    };
    const nextMaps = new Map<Collection, Map<string, string>>();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO control(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        JSON.stringify(header),
      );
      for (const name of collections) {
        const entries =
          name === "commands"
            ? state.commands.map(
                (command, position) =>
                  [String(command.id), { position, command }] as const,
              )
            : Object.entries(state[name]);
        const next = new Map(
          entries.map(([key, value]) => [key, JSON.stringify(value)]),
        );
        const previous = this.persisted.get(name) ?? new Map<string, string>();
        for (const key of previous.keys())
          if (!next.has(key))
            this.storage.sql.exec(`DELETE FROM state_${name} WHERE key=?`, key);
        for (const [key, value] of next)
          if (previous.get(key) !== value)
            this.storage.sql.exec(
              `INSERT INTO state_${name}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
              key,
              value,
            );
        nextMaps.set(name, next);
      }
    });
    this.persisted = nextMaps;
  }
}
