import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function runCodex({ prompt, workingDirectory, mode, model, reasoningEffort, outputSchema, inputImages = [], signal, onEvent }, config) {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "codex-gateway-"));
  const outputFile = path.join(tempDirectory, "last-message.txt");
  const schemaFile = path.join(tempDirectory, "output-schema.json");
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
  if (reasoningEffort) args.push("--config", `model_reasoning_effort=\"${reasoningEffort}\"`);
  if (outputSchema) {
    await writeFile(schemaFile, JSON.stringify(outputSchema), "utf8");
    args.push("--output-schema", schemaFile);
  }
  const imagePaths = await prepareImages(inputImages, tempDirectory);
  for (const imagePath of imagePaths) args.push("--image", imagePath);
  args.push("-");

  try {
    const execution = await spawnCodex(config.codexBin, [...config.codexBinArgs, ...args], prompt, config.timeoutMs, config.codexHome, signal, onEvent);
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

function spawnCodex(command, args, input, timeoutMs, codexHome, signal, onEvent) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
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
    let pending = "";
    let settled = false;
    const maxLogChars = 2_000_000;
    const timer = setTimeout(() => {
      child.kill();
      finishReject(httpError(504, `Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finishReject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk, maxLogChars);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        try { onEvent?.(JSON.parse(line)); } catch { /* Diagnostic output must not break execution. */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, maxLogChars); });
    child.on("error", (error) => {
      finishReject(httpError(503, `Unable to start Codex: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      if (pending) {
        try { onEvent?.(JSON.parse(pending)); } catch { /* Ignore non-JSON tail. */ }
      }
      finishResolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(input, "utf8");

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finishResolve(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function finishReject(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

async function prepareImages(images, directory) {
  const paths = [];
  for (const [index, image] of images.entries()) {
    if (!image.startsWith("data:")) {
      paths.push(image);
      continue;
    }
    const match = image.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw httpError(400, "input_image must use a base64 PNG, JPEG, WEBP, or GIF data URL");
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const imagePath = path.join(directory, `input-${index}.${extension}`);
    await writeFile(imagePath, Buffer.from(match[2], "base64"));
    paths.push(imagePath);
  }
  return paths;
}

function cancelledError() {
  const error = httpError(499, "Request cancelled");
  error.name = "AbortError";
  return error;
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
