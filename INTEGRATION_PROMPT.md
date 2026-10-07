# Codex Local Gateway integration prompt

Give this file to the coding agent working in your client project. The gateway must already be running on the same machine. Supply the local bearer token separately through the client's environment. Keep `openapi.yaml` available as the machine-readable contract and consult the gateway README for operator setup.

## Task for the coding agent

Integrate this project with Codex Local Gateway using its documented HTTP API. Inspect the project's existing architecture and implement a small client consistent with its language and conventions. Use the gateway's authenticated Codex CLI session; do not request an OpenAI API key, inspect browser sessions, or copy cookies. Keep changes limited to the integration and its validation.

### Connection and credentials

- Read the base URL from `CODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:4317`.
- Read `LOCAL_CODEX_GATEWAY_TOKEN` from the environment and send it only in `Authorization: Bearer <token>`.
- Never print, commit, embed, put in a URL, send in a model prompt, or return the token in errors. Do not expose it to browser frontend code; use a local backend when the project has a browser UI.
- Send JSON with `Content-Type: application/json`.
- Use `openapi.yaml` for exact schemas. Do not assume every OpenAI API feature is supported.
- If configuration is missing, explain the required variable names without asking the user to paste secrets into chat.

### Request workflow

1. Call unauthenticated `GET /health` and require `status: "ok"`.
2. Call authenticated `GET /v1/models`. The result is `{ "object": "list", "data": [...] }`. Use a returned model ID when selecting a model, or omit `model` for the Codex default. The catalog is not proof of model access.
3. Send `POST /v1/responses` with a self-contained `input` describing the outcome, constraints, output format, permitted changes, and required validation.
4. Default to `mode: "read-only"` and `include_events: false`. Set `working_directory` only when repository context is needed; it must be an absolute path on the gateway machine inside its configured `CODEX_ALLOWED_ROOTS`.
5. Use a configurable client timeout; 310 seconds is a reasonable starting point for the default server timeout.
6. Check HTTP status and the response body. Require a valid pending `function_call` or non-empty `output_text`; HTTP 200 alone is insufficient. Present `output_text` as final only when no function call remains. Treat `events` as diagnostics.

Use `workspace-write` only when the human explicitly requested changes, the operator enabled `CODEX_ALLOW_WRITES=true`, the working directory is the intended project, and the input names the change and validation. Permission to edit the client project does not automatically authorize gateway tasks to edit other projects.

### Caller-owned function tools

The gateway requests tools but never executes them. If the project needs function calling:

1. Define `type: "function"` tools with argument schemas and a fixed trusted registry of implementations.
2. For every returned `output` item of type `function_call`, resolve `name` against that registry, parse its JSON `arguments`, validate them, and enforce the caller's permissions before execution.
3. Append the returned function-call items and corresponding `{ "type": "function_call_output", "call_id": "...", "output": "..." }` items to the complete original history. Encode non-string tool results as JSON strings.
4. Resend the complete history and the same tool definitions on every continuation. Preserve task instructions and relevant request settings. Do not use `previous_response_id`; the gateway is stateless.
5. Continue until a final answer is returned, with a bounded number of tool rounds. Handle unknown tools and invalid arguments explicitly; never execute arbitrary commands, URLs, or code supplied by the model.

### Errors and diagnostics

Errors have an `error` object containing `message`, `type`, optional `details`, and `request_id`. Capture the `x-request-id` header for support and dashboard lookup, while keeping credentials out of logs.

- `400`, `404`, `413`: correct the request, URL, or input size; do not retry unchanged.
- `401`: report missing or invalid local credentials and request operator configuration out-of-band.
- `403`: report disabled writes; do not silently convert a requested write task into a successful read-only task.
- `429`: back off for queue pressure.
- `499`: stop because the request was cancelled.
- `502`, `503`, `504`: inspect the cause. Missing CLI/configuration or invalid authentication requires a correction; retry only genuinely transient failures.
- Retry transient transport/server failures at most twice with exponential backoff. Avoid blindly retrying write tasks or side-effecting caller functions whose outcome is uncertain.

Authenticated `GET /v1/logs` and `GET /v1/logs/{requestId}` provide diagnostics. Full content exists only if the operator enabled `CODEX_TRACE_CONTENT=true`; treat it as sensitive. The default dashboard is `http://127.0.0.1:4317/dashboard`.

### Minimal real request

Implement and run this harmless request against the configured running gateway, without starting a separate temporary gateway:

```json
{
  "input": "Reply with exactly: gateway integration OK",
  "mode": "read-only",
  "include_events": false
}
```

Send it to `POST /v1/responses` after health and model discovery. Record its request ID and verify that `output_text` contains the requested reply. If function tools are included in the integration, also validate a complete tool-call round trip with a clearly labeled deterministic test fixture; do not present fixture data as real external data.

### Completion report

Report the files changed, configuration variable names, how to call the client, validation performed, and the real gateway request ID. Distinguish mocked checks from successful live requests. If the gateway is unavailable or misconfigured, report that limitation instead of claiming end-to-end success.

Keep the gateway localhost-only. Each user runs their own local instance; `127.0.0.1` refers to the caller's machine. The service is intended for personal, low-concurrency automation, and every request is an ephemeral run with no retained conversation memory.
