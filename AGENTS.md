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
2. If `status` is `ok`, prepare one self-contained task in `input`.
3. Default to `mode: "read-only"`.
4. Set `working_directory` only when the task needs repository context. It must be inside a configured `CODEX_ALLOWED_ROOTS` directory.
5. Call `POST /v1/responses` once and wait for completion.
6. Read the final answer from `output_text`.
7. On a retryable error, retry at most twice with exponential backoff. Never retry authentication, validation, or policy errors without changing the request.

For diagnostics, an authenticated agent may call `GET /v1/logs`. Trace records contain timing, status, mode, workspace basename, and character counts only. Prompt text, output text, bearer tokens, and full workspace paths are deliberately excluded.

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
| `input` | yes | string | — | Complete task for Codex. Must not be empty. |
| `working_directory` | no | absolute path | gateway directory | Workspace Codex may inspect or modify. Must be allowed by the server. |
| `mode` | no | `read-only` or `workspace-write` | `read-only` | Filesystem permission for the Codex run. |
| `include_events` | no | boolean | `false` | Include Codex JSONL events for diagnostics. These may be large. |

Use `workspace-write` only when all of the following are true:

- The human explicitly wants files changed.
- The server was started with `CODEX_ALLOW_WRITES=true`.
- `working_directory` points to the intended project.
- The prompt names the requested change and required validation.

### Successful response

```json
{
  "id": "0d167aad-1353-4f02-94f8-2de035fa35c5",
  "object": "codex.local_response",
  "created_at": 1790474400,
  "output_text": "The final Codex response.",
  "queue_wait_ms": 0,
  "execution_ms": 8421
}
```

Only `output_text` should normally be presented to the caller. Treat `events` as diagnostic data, not as the final answer.

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
- The gateway is not the OpenAI Responses API and is not wire-compatible with the OpenAI SDK.
- Do not expose this server directly to the internet.
- Do not let untrusted callers select arbitrary working directories.
- Do not assume success from HTTP `200` alone; require a non-empty `output_text`.
