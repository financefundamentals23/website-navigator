import { DatabaseSync } from "node:sqlite";

export const db = new DatabaseSync(process.env.NAV_DB ?? "nav.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS elements (
    site TEXT NOT NULL,
    page TEXT NOT NULL,
    label TEXT NOT NULL,
    role TEXT NOT NULL,
    parent TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (site, page, label, parent)
  );
  CREATE TABLE IF NOT EXISTS answers (
    site TEXT NOT NULL,
    q TEXT NOT NULL,
    json TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (site, q)
  );
`);

export type El = { page: string; label: string; role: string; parent: string };

export function putElements(site: string, els: El[]) {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO elements (site, page, label, role, parent) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const e of els) ins.run(site, e.page, e.label, e.role, e.parent);
}

export function getElements(site: string): El[] {
  return db
    .prepare(`SELECT page, label, role, parent FROM elements WHERE site = ?`)
    .all(site) as El[];
}

export function clearSite(site: string) {
  db.prepare(`DELETE FROM elements WHERE site = ?`).run(site);
  db.prepare(`DELETE FROM answers WHERE site = ?`).run(site);
}
