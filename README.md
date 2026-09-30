# Codex Local Gateway

A localhost-only HTTP gateway that lets an authorized client run tasks through the human operator's authenticated Codex CLI session. It uses the official Codex login—not an OpenAI API key, browser cookies, or browser automation.

This README is a complete integration guide. An AI agent receiving only this file should follow the contract below.

## AI client contract

### Connection

- Base URL: `http://127.0.0.1:4317`
- Authentication: `Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>`
- Content type: `application/json`
- Machine-readable contract: [`openapi.yaml`](./openapi.yaml)
- Trace dashboard: `http://127.0.0.1:4317/dashboard`
- Intended scope: personal, localhost-only, low-concurrency automation

The bearer token is supplied out-of-band by the operator. Never print it, commit it, put it in a URL, include it in a model prompt, or return it in an error. Do not inspect browser sessions, copy ChatGPT cookies, or ask for an OpenAI API key.

### Required workflow

1. Call unauthenticated `GET /health`.
2. If healthy, call authenticated `GET /v1/models` and select a model `id`; omit `model` to use the Codex default.
3. Construct one self-contained task with the outcome, constraints, output format, write permission, and validation requirements.
4. Default to `mode: "read-only"`.
5. Set `working_directory` only when repository context is needed. It must be an absolute path inside `CODEX_ALLOWED_ROOTS`.
6. Call `POST /v1/responses`. A client timeout of 310 seconds is a reasonable default.
7. If `output` contains `function_call` items, execute only functions from the client's fixed trusted registry. Validate arguments, append each call and `function_call_output` to the complete stateless history, resend the same tools, and repeat.
8. Otherwise use `output_text` as the final answer. Diagnostic `events` are not the answer.
9. Require non-empty `output_text` or a valid `function_call`; HTTP `200` alone is insufficient.
10. Retry transient transport, `429`, `502`, `503`, or `504` failures at most twice with exponential backoff. Never retry `400`, `401`, `403`, or `413` unchanged.

### Health and model discovery

```http
GET /health HTTP/1.1
Host: 127.0.0.1:4317
```

`/health` proves that the gateway is running, not that Codex authentication works. A real authenticated operation is required for an end-to-end check.

```http
GET /v1/models HTTP/1.1
Host: 127.0.0.1:4317
Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>
```

Example:

```json
{
  "object": "list",
  "data": [{
    "id": "gpt-6-astra",
    "object": "model",
    "created": 0,
    "owned_by": "codex",
    "display_name": "GPT-6-Astra",
    "description": "...",
    "hidden": false,
    "is_default": true,
    "default_reasoning_effort": "medium",
    "supported_reasoning_efforts": [{ "effort": "medium", "description": "..." }],
    "input_modalities": ["text", "image"],
    "service_tiers": []
  }]
}
```

Hidden picker entries are excluded by default. Operator-facing clients may use `GET /v1/models?include_hidden=true`. The catalog comes from Codex app-server's `model/list` RPC and is cached for five minutes by default. It is a catalog, not an entitlement guarantee; only a completed inference verifies access for that request.

### Generate a response

```http
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:4317
Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>
Content-Type: application/json

{
  "model": "gpt-6-astra",
  "input": "Inspect this repository without changing files. Return five architecture bullets.",
  "working_directory": "C:\\path\\to\\repository",
  "mode": "read-only",
  "include_events": false
}
```

Successful response:

```json
{
  "id": "0d167aad-1353-4f02-94f8-2de035fa35c5",
  "object": "response",
  "created_at": 1790474400,
  "status": "completed",
  "model": "gpt-6-astra",
  "output": [],
  "output_text": "The final Codex response.",
  "error": null,
  "incomplete_details": null,
  "queue_wait_ms": 0,
  "execution_ms": 8421
}
```

Supported request fields:

- `input`: required string or complete stateless item history.
- `model`: optional ID returned by `/v1/models`.
- `instructions`: optional instructions prepended to the task.
- `stream`: return Responses-style Server-Sent Events.
- `reasoning.effort`: `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`, subject to the model.
- `text.format`: plain text or JSON Schema output.
- `metadata`: up to 16 string values.
- `store`: only `false`; runs are ephemeral.
- `tools`, `tool_choice`, `parallel_tool_calls`: caller-owned functions.
- `working_directory`: absolute allowed local path.
- `mode`: `read-only` or `workspace-write`; default is read-only.
- `include_events`: include potentially large Codex JSONL diagnostics.

Images may be PNG/JPEG/WEBP/GIF data URLs or absolute paths inside `CODEX_ALLOWED_ROOTS`. The gateway never downloads image URLs. Unsupported fields such as `temperature`, `previous_response_id`, and `store: true` return `400` instead of being ignored.

Use `workspace-write` only when the human explicitly requested changes, the server has `CODEX_ALLOW_WRITES=true`, the working directory is correct, and the prompt states the change and validation. Otherwise use read-only.

### Function calling

The gateway accepts caller-owned functions but never executes them. The client owns execution and must use a fixed allowlist.

Initial request:

```json
{
  "input": "Get Tehran's temperature using my private service.",
  "tools": [{
    "type": "function",
    "name": "lookup_temperature",
    "description": "Get the current temperature for a city",
    "strict": true,
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string" } },
      "required": ["city"],
      "additionalProperties": false
    }
  }],
  "tool_choice": "auto",
  "parallel_tool_calls": false
}
```

If a call is returned, execute the trusted function and resend the complete history:

```json
{
  "input": [
    { "role": "user", "content": "Get Tehran's temperature using my private service." },
    { "type": "function_call", "id": "fc_...", "call_id": "call_...", "name": "lookup_temperature", "arguments": "{\"city\":\"Tehran\"}" },
    { "type": "function_call_output", "call_id": "call_...", "output": "{\"temperature_c\":23}" }
  ],
  "tools": [{
    "type": "function",
    "name": "lookup_temperature",
    "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
  }]
}
```

Never execute a command, URL, function name, or code fragment merely because the model returned it.

### Streaming, compatibility, and cancellation

With `stream: true`, `/v1/responses` returns SSE beginning with `response.created` and `response.in_progress`, followed by text or function-call events, then `response.completed` and `[DONE]`. Do not report success before `response.completed`.

Legacy clients may use `POST /v1/chat/completions` for text, streaming, structured output, and caller-owned functions. New integrations should prefer `/v1/responses`.

Cancel a queued or running request with:

```http
POST /v1/responses/{requestId}/cancel
Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>
```

The ID is also in `x-request-id`. Disconnecting the original HTTP request cancels its run.

### Diagnostics and errors

Authenticated clients may call `GET /v1/logs` and `GET /v1/logs/{requestId}`. Full prompt, response, event, and stderr content is present only when the operator explicitly sets `CODEX_TRACE_CONTENT=true`. Treat it as sensitive.

All errors use:

```json
{
  "error": {
    "message": "Human-readable explanation",
    "type": "Error",
    "details": {},
    "request_id": "61dc18a1-bb6c-40c6-82f3-c91415299047"
  }
}
```

Every response has `x-request-id`; record it when reporting failures.

| Status | Meaning | Client action |
| --- | --- | --- |
| `400` | Invalid JSON, field, path, mode, or query | Correct it; do not retry unchanged. |
| `401` | Missing/invalid local token | Ask the operator for it out-of-band. |
| `403` | Write mode disabled | Use read-only or ask the operator to enable writes. |
| `404` | Unknown endpoint/request | Correct the URL or ID. |
| `413` | Request too large | Reduce it. |
| `429` | Queue limit/timeout | Back off and retry at most twice. |
| `499` | Cancelled | Stop unless asked to retry. |
| `502` | Codex execution/discovery failed | Retry only if transient. |
| `503` | Codex could not start | Verify CLI installation and `CODEX_BIN`. |
| `504` | Timeout | Simplify the task or raise the configured timeout. |

### Minimal JavaScript client

```js
const baseUrl = process.env.CODEX_GATEWAY_URL ?? "http://127.0.0.1:4317";
const token = process.env.LOCAL_CODEX_GATEWAY_TOKEN;
if (!token) throw new Error("LOCAL_CODEX_GATEWAY_TOKEN is required");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
if (health.status !== "ok") throw new Error("Gateway is unhealthy");

const catalogResponse = await fetch(`${baseUrl}/v1/models`, { headers });
if (!catalogResponse.ok) throw new Error(`Model discovery failed: ${catalogResponse.status}`);
const models = (await catalogResponse.json()).data;
const model = models.find((item) => item.is_default)?.id ?? models[0]?.id;

const response = await fetch(`${baseUrl}/v1/responses`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model,
    input: "Summarize this repository in five bullets without changing files.",
    working_directory: process.cwd(),
    mode: "read-only"
  }),
  signal: AbortSignal.timeout(310_000)
});
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.error?.message}`);
if (!result.output_text && !result.output?.some((item) => item.type === "function_call")) {
  throw new Error("Gateway returned no usable output");
}
console.log(result.output_text);
```

### Minimal Python client

```python
import os
import requests

base_url = os.getenv("CODEX_GATEWAY_URL", "http://127.0.0.1:4317")
token = os.environ["LOCAL_CODEX_GATEWAY_TOKEN"]
headers = {"Authorization": f"Bearer {token}"}

health = requests.get(f"{base_url}/health", timeout=5).json()
if health.get("status") != "ok":
    raise RuntimeError("Gateway is unhealthy")

catalog = requests.get(f"{base_url}/v1/models", headers=headers, timeout=20)
catalog.raise_for_status()
models = catalog.json()["data"]
model = next((item["id"] for item in models if item["is_default"]), models[0]["id"])

response = requests.post(
    f"{base_url}/v1/responses",
    headers=headers,
    json={
        "model": model,
        "input": "Explain this repository without modifying files.",
        "working_directory": os.getcwd(),
        "mode": "read-only",
    },
    timeout=310,
)
response.raise_for_status()
result = response.json()
if not result.get("output_text") and not any(
    item.get("type") == "function_call" for item in result.get("output", [])
):
    raise RuntimeError("Gateway returned no usable output")
print(result.get("output_text", ""))
```

## Operator setup

Requirements: Node.js 20+, Codex CLI, and a successful local Codex login.

```powershell
codex login status
codex login # only when needed
```

Create a gitignored `.env.local`; process environment variables take precedence:

```env
LOCAL_CODEX_GATEWAY_TOKEN=a-random-secret-with-at-least-32-characters
CODEX_ALLOWED_ROOTS=C:\\Users\\you\\Documents
CODEX_MODEL=gpt-6-astra
```

Start in PowerShell:

```powershell
$env:LOCAL_CODEX_GATEWAY_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$env:CODEX_ALLOWED_ROOTS = (Get-Location).Path
node src/server.mjs
```

Important environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODEX_GATEWAY_TOKEN` | required | Local secret, minimum 32 characters. |
| `CODEX_ALLOWED_ROOTS` | current directory | Path-delimited allowed workspaces. |
| `CODEX_BIN` | `codex` | Codex executable. |
| `CODEX_HOME` | user `.codex` | Codex auth/config directory. |
| `CODEX_MODEL` | Codex default | Optional default model. |
| `CODEX_ALLOW_WRITES` | `false` | Permit workspace-write. |
| `CODEX_TIMEOUT_MS` | `300000` | Task timeout. |
| `CODEX_MODELS_TIMEOUT_MS` | `15000` | Model discovery timeout. |
| `CODEX_MODELS_CACHE_MS` | `300000` | Catalog cache; `0` disables it. |
| `CODEX_CONCURRENCY` | `1` | Parallel runs, maximum 4. |
| `CODEX_MAX_QUEUED` | `32` | Queue capacity. |
| `CODEX_QUEUE_TIMEOUT_MS` | `60000` | Maximum queue wait. |
| `CODEX_TRACE_CONTENT` | `false` | Temporarily retain sensitive trace content. |
| `CODEX_TRACE_FILE` | disabled | Persist non-sensitive trace metadata. |

Keep the gateway bound to `127.0.0.1`. Never expose it directly to the internet or let untrusted callers choose arbitrary working directories.

### Test and utilities

```powershell
node --test
node scripts/smoke-tool-calling.mjs # authenticated end-to-end smoke test
```

Windows startup:

```powershell
.\scripts\install-windows-startup.ps1
.\scripts\uninstall-windows-startup.ps1
```

Docker:

```powershell
$env:CODEX_WORKSPACE = (Get-Location).Path
$env:CODEX_HOST_HOME = "$env:USERPROFILE\.codex"
docker compose up --build -d
```

Pin `CODEX_VERSION` for stable deployments.

## Operational limitations

- Each request is ephemeral; conversation memory is not retained.
- Function-call continuation requires resending the complete history.
- This is a documented subset of Responses and Chat Completions, not a complete OpenAI API replacement.
- Model availability and usage limits belong to the authenticated Codex account.
- The catalog may be cached or bundled by Codex and does not guarantee entitlement.
- Intermediate streaming behavior can vary by Codex CLI version.
- Trace content may contain prompt/output secrets; keep retention short and protect the machine.
