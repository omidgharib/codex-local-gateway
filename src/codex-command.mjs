import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// Resolve on every launch: desktop updates replace the versioned bin directory.
export async function resolveCodexCommand(config, { platform = process.platform, env = process.env } = {}) {
  if (config.codexBin && config.codexBin !== "codex") {
    return { command: config.codexBin, args: config.codexBinArgs || [] };
  }
  if (platform === "win32" && env.LOCALAPPDATA && !config.codexBinArgs?.length) {
    const root = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const command = path.join(root, entry.name, "codex.exe");
      const info = await stat(command).catch(() => null);
      return info?.isFile() ? { command, modified: info.mtimeMs } : null;
    }));
    const latest = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0];
    if (latest) return { command: latest.command, args: [] };
  }
  return { command: config.codexBin || "codex", args: config.codexBinArgs || [] };
}
