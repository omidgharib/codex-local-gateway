import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexCommand } from "../src/codex-command.mjs";

test("discovers desktop updates without restarting and ignores incomplete installs", async () => {
  const local = await mkdtemp(path.join(os.tmpdir(), "codex-discovery-"));
  const root = path.join(local, "OpenAI", "Codex", "bin");
  const options = { platform: "win32", env: { LOCALAPPDATA: local } };
  const config = { codexBin: "codex", codexBinArgs: [] };
  try {
    assert.equal((await resolveCodexCommand(config, options)).command, "codex");
    const old = path.join(root, "old", "codex.exe");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, "");
    await utimes(old, 1, 1);
    assert.equal((await resolveCodexCommand(config, options)).command, old);
    const updated = path.join(root, "new", "codex.exe");
    await mkdir(path.dirname(updated), { recursive: true });
    await writeFile(updated, "");
    await mkdir(path.join(root, "incomplete"));
    assert.equal((await resolveCodexCommand(config, options)).command, updated);
    assert.deepEqual(await resolveCodexCommand({ codexBin: "custom", codexBinArgs: ["arg"] }, options), { command: "custom", args: ["arg"] });
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("preserves PATH fallback and caller arguments", async () => {
  assert.deepEqual(await resolveCodexCommand({ codexBin: "codex", codexBinArgs: ["arg"] }, { platform: "linux", env: {} }), { command: "codex", args: ["arg"] });
});
