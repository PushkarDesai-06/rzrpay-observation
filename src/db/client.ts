import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "@/db/schema.generated";

export type Database = DatabaseSync;

/**
 * Apply the schema.
 *
 * The SQL is compiled in rather than read from disk: a bundler cannot trace a
 * runtime file read, so a deployed server could otherwise start without its
 * schema. src/db/schema.sql remains the source of truth and is regenerated
 * into a module before every dev run and build.
 */
export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Open a database and bring it up to schema. Safe to call repeatedly:
 * every DDL statement in schema.sql is IF NOT EXISTS.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  applySchema(db);
  return db;
}

/** A fresh in-memory database. Used by every test suite for isolation. */
export function openTestDatabase(): Database {
  return openDatabase(":memory:");
}

let singleton: Database | undefined;

/** Process-wide connection for the running app. */
export function getDatabase(path?: string): Database {
  if (!singleton) {
    singleton = openDatabase(path ?? process.env.DATABASE_PATH ?? "./data/recovery.db");
  }
  return singleton;
}

export function closeDatabase(): void {
  singleton?.close();
  singleton = undefined;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 * State changes that must be atomic with their audit record use this.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** SQLite has no boolean type; these keep the 0/1 conversion in one place. */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0);
export const fromSqlBool = (value: number): boolean => value === 1;
