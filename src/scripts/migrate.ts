import { loadEnvFile } from "@/config/load-env";
import { openDatabase } from "@/db/client";

// Read .env before anything inspects process.env.
loadEnvFile();

const path = process.env.DATABASE_PATH ?? "./data/recovery.db";
const db = openDatabase(path);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];

console.log(`Schema applied to ${path}`);
console.log(`${tables.length} tables: ${tables.map((t) => t.name).join(", ")}`);
db.close();
