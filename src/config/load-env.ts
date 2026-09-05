import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Snapshot of the real environment, taken before any file is read.
 * Captured at module load so it cannot be polluted by a later .env read.
 */
const SHELL_ENV = new Map(Object.entries(process.env) as Array<[string, string]>);

/**
 * Load .env into process.env for CLI entry points.
 *
 * Uses Node's built-in loader rather than a dependency. Next.js reads .env
 * itself, so only the scripts need this.
 *
 * Variables exported in the shell take precedence over the file, which is what
 * makes `LLM_MODEL=x npm run demo` work as a one-off override.
 */
export function loadEnvFile(path = ".env"): boolean {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute)) return false;

  try {
    process.loadEnvFile(absolute);
  } catch (error) {
    console.warn(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  // process.loadEnvFile overwrites, so put the shell's own values back.
  for (const [key, value] of SHELL_ENV) {
    process.env[key] = value;
  }
  return true;
}
