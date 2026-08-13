# A2A Demo Guide

Demonstrates how to invoke a published a2wave Agent with the official A2A 1.0 client. The server also accepts A2A 0.3 JSON-RPC clients during migration.

## Prerequisites

1. Run `pnpm run dev` to start the API (defaults to `http://127.0.0.1:3502`)
2. Create and publish an Agent in the Web UI, with a publishing channel that includes the **A2A protocol**
3. If the Agent is configured with API Key authentication, include `Authorization: Bearer <apiKey>` in the request

## Option 1: Use the Demo Script (Recommended)

A TypeScript script using the `@a2a-js/sdk` client:

```bash
# Run from the project root (recommended) — synchronous blocking mode
pnpm a2a-demo -- agt_xxx "Hello, A2A!"

# Streaming output (real-time SSE increments)
pnpm a2a-demo -- agt_xxx "Stream me updates" --stream

# Async mode (non-blocking submit + automatic polling)
pnpm a2a-demo -- agt_xxx "Do something slow" --async

# Using environment variables
AGENT_ID=agt_xxx MESSAGE="Your prompt" pnpm a2a-demo

# With API Key authentication
AGENT_ID=agt_xxx API_KEY=your-api-key pnpm a2a-demo
```

### Three Modes

| Mode | Flag | Behavior |
|------|------|------|
| **blocking** (default) | none | Synchronously waits for the Agent to finish, then returns the full result |
| **stream** | `--stream` | Receives incremental output in real time via SSE |
| **async** | `--async` | Non-blocking submit that returns a task ID immediately, then automatically polls `GetTask` until the task completes |

Parameters:

| Parameter/Env Variable | Description |
|---------------|------|
| `AGENT_ID` | Agent ID (e.g. `agt_xxx`), required |
| `MESSAGE` | The text sent to the Agent, defaults to `"Hello, A2A!"` |
| `BASE_URL` | API address, defaults to `http://127.0.0.1:3502` |
| `API_KEY` | Required when the Agent is configured with API Key authentication |
| `--stream` | Use streaming output (SSE) |
| `--async` | Use async mode (non-blocking + polling) |
| `TIMEOUT` | Demo client deadline (milliseconds), defaults to 300000 (5 minutes); this does not configure the Agent router or server-side Run timeout |
| `POLL_INTERVAL` | Async-mode polling interval (milliseconds), defaults to 2000 |
| `DEBUG=1` or `A2A_DEMO_DEBUG=1` | Output debug logs to stderr |

## Option 2: curl Examples

### 1. Fetch the Agent Card

```bash
# No authentication (A2A auth is none or IP allowlist)
curl -s -H "A2A-Version: 1.0" \
  "http://127.0.0.1:3502/api/a2a/agt_xxx/.well-known/agent-card.json"

# With API Key
curl -s -H "A2A-Version: 1.0" -H "Authorization: Bearer YOUR_API_KEY" \
  "http://127.0.0.1:3502/api/a2a/agt_xxx/.well-known/agent-card.json"
```

The Agent Card is version-negotiated: request `A2A-Version: 1.0` for the standard v1 shape. Omitting the header intentionally returns the v0.3-compatible shape for legacy clients.

### 2. Send an A2A 1.0 JSON-RPC Message (`SendMessage`)

```bash
curl -s -X POST "http://127.0.0.1:3502/api/a2a/agt_xxx" \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendMessage",
    "params": {
      "tenant": "",
      "message": {
        "messageId": "msg-001",
        "role": "ROLE_USER",
        "parts": [{ "text": "Hello, A2A!", "mediaType": "text/plain" }]
      },
      "configuration": {
        "returnImmediately": false,
        "acceptedOutputModes": ["text/plain"]
      }
    }
  }'
```

### 3. Async Mode (non-blocking + polling)

```bash
# Step 1: non-blocking submit, returns taskId immediately
curl -s -X POST "http://127.0.0.1:3502/api/a2a/agt_xxx" \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendMessage",
    "params": {
      "tenant": "",
      "message": {
        "messageId": "msg-async-001",
        "role": "ROLE_USER",
        "parts": [{ "text": "Hello async!", "mediaType": "text/plain" }]
      },
      "configuration": {
        "returnImmediately": true,
        "acceptedOutputModes": ["text/plain"]
      }
    }
  }'
# → returns { "result": { "id": "task_xxx", "status": { "state": "TASK_STATE_SUBMITTED" }, ... } }

# Step 2: poll with the taskId until completion
curl -s -X POST "http://127.0.0.1:3502/api/a2a/agt_xxx" \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "GetTask",
    "params": { "tenant": "", "id": "task_xxx" }
  }'
# → repeat until status.state is TASK_STATE_COMPLETED, TASK_STATE_FAILED,
#   TASK_STATE_CANCELED, or TASK_STATE_REJECTED
```

For streaming, use `SendStreamingMessage` with the same v1 request body. The response is SSE and closes when the task reaches a terminal state. Every JSON-RPC response contains either a `result` or an `error` field.

### A2A 0.3 Compatibility

Existing clients may continue to use `message/send`, `message/stream`, `tasks/get`, and `tasks/cancel`, with `kind` discriminators and lowercase role/task-state values. Requests without an `A2A-Version` header are treated as A2A 0.3 unless the v1 method name unambiguously selects the v1 handler.

## Endpoints

| Endpoint | Method | Description |
|------|------|------|
| `/api/a2a/:agentId/.well-known/agent-card.json` | GET | Agent Card discovery |
| `/api/a2a/:agentId` | POST | JSON-RPC endpoint (A2A 1.0 and A2A 0.3 compatibility) |

## References

- [A2A Protocol](https://a2a-protocol.org/latest/)
- [A2A source and specification](https://github.com/a2aproject/A2A)
- [a2wave A2A Task lifecycle](./agent/a2a-task-lifecycle.md)
- [@a2a-js/sdk](https://www.npmjs.com/package/@a2a-js/sdk)
