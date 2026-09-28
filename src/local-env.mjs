import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads simple KEY=value entries from .env.local without overriding variables
 * provided by the calling environment. The file is intentionally optional.
 */
export function loadLocalEnv(filePath = path.join(process.cwd(), ".env.local"), env = process.env) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (env[key] !== undefined) continue;
    env[key] = unquote(rawValue.trim());
  }
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
