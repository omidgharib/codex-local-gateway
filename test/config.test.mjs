import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, resolveWorkingDirectory } from "../src/config.mjs";

test("requires a strong local token", () => {
  assert.throws(() => loadConfig({}, process.cwd()), /at least 32/);
});

test("accepts a directory inside an allowed root", () => {
  const root = path.resolve("test-root");
  const config = loadConfig({
    LOCAL_CODEX_GATEWAY_TOKEN: "a".repeat(32),
    CODEX_ALLOWED_ROOTS: root,
  });
  assert.equal(resolveWorkingDirectory(path.join(root, "child"), config), path.join(root, "child"));
});

test("rejects a directory outside allowed roots", () => {
  const root = path.resolve("test-root");
  const config = loadConfig({
    LOCAL_CODEX_GATEWAY_TOKEN: "a".repeat(32),
    CODEX_ALLOWED_ROOTS: root,
  });
  assert.throws(() => resolveWorkingDirectory(path.resolve("elsewhere"), config), /outside/);
});
