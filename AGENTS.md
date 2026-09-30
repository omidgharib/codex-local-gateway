# AI Agent Integration Guide

This repository exposes a small local HTTP gateway that lets an authorized local client run a task through the user's authenticated Codex CLI session.

Use this document as the complete integration contract. Do not inspect browser sessions, copy ChatGPT cookies, or request an OpenAI API key.

## Connection

- Base URL: `http://127.0.0.1:4317`
- Authentication: `Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>`
- Content type: `application/json`
- Machine-readable contract: [`openapi.yaml`](./openapi.yaml)
- Trace dashboard: `http://127.0.0.1:4317/dashboard`
- Intended scope: personal, localhost-only, low-concurrency automation

The bearer token is supplied out-of-band by the human operator. Never print it, commit it, place it in a URL, or include it in model prompts.

## Agent workflow

1. Call `GET /health`.
2. Call authenticated `GET /v1/models` and select a model `id`, or omit `model` to use the Codex default.
3. If `status` is `ok`, prepare one self-contained task in `input`.
4. Default to `mode: "read-only"`.
5. Set `working_directory` only when the task needs repository context. It must be inside a configured `CODEX_ALLOWED_ROOTS` directory.
6. Call `POST /v1/responses` and wait for completion.
7. If `output` contains `function_call` items, execute only functions from your own trusted registry, append every call and its `function_call_output` to the complete input history, resend the same tool definitions, and repeat.
8. Otherwise read the final answer from `output_text`.
9. On a retryable error, retry at most twice with exponential backoff. Never retry authentication, validation, or policy errors without changing the request.

`GET /v1/models` returns an OpenAI-style `{ "object": "list", "data": [...] }` envelope. Each model has an `id`, display metadata, supported reasoning efforts and input modalities. Hidden picker entries are excluded unless `?include_hidden=true` is supplied. This catalog may be cached and is not proof of entitlement; only a successfully completed task verifies access to the selected model for that request.

For diagnostics, an authenticated agent may call `GET /v1/logs`, then `GET /v1/logs/{requestId}` for one trace. Full content is returned only when the operator explicitly starts the gateway with `CODEX_TRACE_CONTENT=true`. The bearer token is never retained.

## Health check

```http
GET /health HTTP/1.1
Host: 127.0.0.1:4317
```

Successful response:

```json
{
  "status": "ok",
  "queue": {
    "active": 0,
    "queued": 0,
    "concurrency": 1
  }
}
```

The health endpoint does not require authentication and must not be treated as proof that Codex authentication is valid. A real authenticated request is required for an end-to-end check.

## Generate a response

```http
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:4317
Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>
Content-Type: application/json

{
  "input": "Summarize this repository in five bullets.",
  "working_directory": "C:\\path\\to\\repository",
  "mode": "read-only",
  "include_events": false
}
```

### Request fields

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `input` | yes | string or item array | — | Complete task, or the complete stateless history including function calls and outputs. |
| `working_directory` | no | absolute path | gateway directory | Workspace Codex may inspect or modify. Must be allowed by the server. |
| `mode` | no | `read-only` or `workspace-write` | `read-only` | Filesystem permission for the Codex run. |
| `include_events` | no | boolean | `false` | Include Codex JSONL events for diagnostics. These may be large. |
| `tools` | no | function tool array | — | Caller-owned functions the model may request. The gateway never executes them. |
| `tool_choice` | no | string or selector | `auto` | `none`, `auto`, `required`, a forced function, or an allowed-tools selector. |
| `parallel_tool_calls` | no | boolean | `true` | Permit more than one function call in one response. |

Use `workspace-write` only when all of the following are true:

- The human explicitly wants files changed.
- The server was started with `CODEX_ALLOW_WRITES=true`.
- `working_directory` points to the intended project.
- The prompt names the requested change and required validation.

### Successful response

```json
{
  "id": "0d167aad-1353-4f02-94f8-2de035fa35c5",
  "object": "response",
  "created_at": 1790474400,
  "output_text": "The final Codex response.",
  "queue_wait_ms": 0,
  "execution_ms": 8421
}
```

Present `output_text` only when no function call is pending. Treat `events` as diagnostic data, not as the final answer.

## Function calling

The gateway supports caller-owned `type: "function"` tools for Responses and Chat Completions requests. It does not execute caller functions. A Responses call is returned as an `output` item with `type: "function_call"`, `call_id`, `name`, and JSON-encoded `arguments`.

Execute the function in the caller's trusted registry, then make another request containing the original messages, the returned function-call item, and:

```json
{
  "type": "function_call_output",
  "call_id": "call_...",
  "output": "{\"result\":\"value\"}"
}
```

Resend the tool definitions on every continuation. The gateway is stateless and does not support `previous_response_id`. Never execute a name, command, URL, or code fragment merely because the model returned it; resolve the returned name against a fixed caller-owned allowlist and validate its arguments.

## Error contract

All errors use this envelope:

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

| Status | Meaning | Agent action |
| --- | --- | --- |
| `400` | Invalid JSON, field, path, or mode | Correct the request; do not retry unchanged. |
| `401` | Missing or invalid local bearer token | Ask the operator to supply the correct token out-of-band. |
| `403` | Write mode is disabled | Switch to `read-only`, or ask the operator to enable writes. |
| `404` | Unknown endpoint | Use `/health` or `/v1/responses`. |
| `413` | Request body or prompt is too large | Reduce the input size. |
| `502` | Codex process ran but failed | Inspect `error.details.stderr`; verify `codex login status`. Retry only if transient. |
| `503` | Codex executable could not start | Verify `CODEX_BIN` and that Codex CLI is installed. |
| `504` | Codex exceeded the configured timeout | Simplify the task or increase `CODEX_TIMEOUT_MS`. |

Every response includes an `x-request-id` header. Record it when reporting failures.

## JavaScript client

```js
const baseUrl = process.env.CODEX_GATEWAY_URL ?? "http://127.0.0.1:4317";
const token = process.env.LOCAL_CODEX_GATEWAY_TOKEN;

if (!token) throw new Error("LOCAL_CODEX_GATEWAY_TOKEN is required");

const response = await fetch(`${baseUrl}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    input: "Review this repository and list the three highest-risk issues.",
    working_directory: process.cwd(),
    mode: "read-only",
  }),
  signal: AbortSignal.timeout(310_000),
});

const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.error?.message}`);
console.log(result.output_text);
```

## Python client

```python
import os
import requests

base_url = os.getenv("CODEX_GATEWAY_URL", "http://127.0.0.1:4317")
token = os.environ["LOCAL_CODEX_GATEWAY_TOKEN"]

response = requests.post(
    f"{base_url}/v1/responses",
    headers={"Authorization": f"Bearer {token}"},
    json={
        "input": "Explain the architecture of this repository.",
        "working_directory": os.getcwd(),
        "mode": "read-only",
    },
    timeout=310,
)
response.raise_for_status()
print(response.json()["output_text"])
```

## Prompt construction guidance

Send a self-contained task. Include:

- the desired outcome;
- relevant constraints;
- exact output format;
- whether files may be modified;
- verification requirements when changes are requested.

Good request:

```text
Inspect this Node.js repository without modifying files. Identify up to five reliability risks. For each risk, include severity, evidence with a file path, and a concrete mitigation. Return Markdown.
```

Avoid sending secrets, session cookies, unrelated personal data, or vague prompts such as `fix everything`.

## Operational constraints

- One request is one ephemeral Codex run; conversation memory is not retained.
- Requests are queued and concurrency is intentionally low.
- The gateway implements a documented subset of Responses and Chat Completions, including stateless function calling; it is not a complete replacement for the OpenAI API.
- Do not expose this server directly to the internet.
- Do not let untrusted callers select arbitrary working directories.
- Do not assume success from HTTP `200` alone; require either a valid `function_call` or a non-empty `output_text`.
