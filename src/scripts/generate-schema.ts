/**
 * Embed schema.sql into a TypeScript module.
 *
 * The bundler cannot trace a runtime readFileSync, so a deployed build may not
 * ship schema.sql at all — a failure that only appears in production. Keeping
 * the .sql file authoritative and generating a module from it removes the file
 * read without giving up a readable, diffable schema. A test asserts the two
 * never drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = join(process.cwd(), "src", "db", "schema.sql");
const target = join(process.cwd(), "src", "db", "schema.generated.ts");

const sql = readFileSync(source, "utf8");
const banner = `// GENERATED FROM src/db/schema.sql — do not edit.\n// Regenerate with: npm run schema:generate\n`;
const body = `${banner}\nexport const SCHEMA_SQL = ${JSON.stringify(sql)};\n`;

writeFileSync(target, body, "utf8");
console.log(`Wrote ${target} (${sql.length} chars)`);
