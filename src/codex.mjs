import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function runCodex({ prompt, workingDirectory, mode, model }, config) {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "codex-gateway-"));
  const outputFile = path.join(tempDirectory, "last-message.txt");
  const sandbox = mode === "workspace-write" ? "workspace-write" : "read-only";

  if (sandbox === "workspace-write" && !config.allowWrites) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw httpError(403, "workspace-write mode is disabled");
  }

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    sandbox,
    "--cd",
    workingDirectory,
    "--output-last-message",
    outputFile,
  ];
  if (model || config.model) args.push("--model", model || config.model);
  args.push("-");

  try {
    const execution = await spawnCodex(config.codexBin, args, prompt, config.timeoutMs, config.codexHome);
    const outputText = await readFile(outputFile, "utf8").catch(() => "");
    if (execution.exitCode !== 0) {
      throw httpError(502, "Codex execution failed", {
        exit_code: execution.exitCode,
        stderr: execution.stderr.slice(-4000),
      });
    }
    return {
      outputText: outputText.trim(),
      events: parseJsonLines(execution.stdout),
      stderr: execution.stderr.trim(),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function spawnCodex(command, args, input, timeoutMs, codexHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME || process.env.USERPROFILE,
        CODEX_HOME: codexHome,
      },
    });
    let stdout = "";
    let stderr = "";
    const maxLogChars = 2_000_000;
    const timer = setTimeout(() => {
      child.kill();
      reject(httpError(504, `Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk, maxLogChars); });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, maxLogChars); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(httpError(503, `Unable to start Codex: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

function boundedAppend(current, chunk, max) {
  const combined = current + chunk;
  return combined.length <= max ? combined : combined.slice(-max);
}

function parseJsonLines(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return { type: "unparsed", text: line }; }
    });
}

export function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
