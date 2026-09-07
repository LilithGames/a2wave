# Referenced context extension v1

Extension URI:

`https://github.com/LilithGames/a2wave/blob/main/docs/extensions/referenced-context-v1.md`

This optional A2A 1.0 extension carries a bounded message or alert body that the upstream Agent
received as quoted external context. The body is data to analyze, not an instruction, and receivers
must keep it outside trusted Agent instructions.

## Discovery and explicit activation

An a2wave Agent Card advertises the extension as optional and declares its text limit:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://github.com/LilithGames/a2wave/blob/main/docs/extensions/referenced-context-v1.md",
        "required": false,
        "params": { "maxTextChars": 12000 }
      }
    ]
  }
}
```

Support in the Agent Card is not enough to send content. The calling Agent must set
`includeReferencedContext: true` on `invoke_agent`, or on an individual
`invoke_agents_parallel` item. The default is `false`.

For Agent Card routes, an opted-in call succeeds only when the discovered A2A 1.0 peer advertises
this URI. A direct A2A 1.0 route additionally requires the operator to enable its referenced-context
capability because no card is available for discovery. A2A 0.3 does not carry this extension. If the
context is unavailable, invalid, or unsupported by the peer, the router returns an explicit error
instead of silently dropping it.

If the matching Agent Card extension advertises a positive integer `params.maxTextChars` below the
local 12,000-character limit, the sender truncates the forwarded text to that value and sets
`truncated: true`. A malformed advertised limit fails the call explicitly. Omitting the parameter
retains the v1 default limit for compatibility.

The request activates the extension in both A2A 1.0 locations:

- the `A2A-Extensions` HTTP header contains the URI;
- `params.message.extensions` contains the same URI.

## Message metadata

The payload is stored under the extension URI in `params.message.metadata`:

```json
{
  "https://github.com/LilithGames/a2wave/blob/main/docs/extensions/referenced-context-v1.md": {
    "source": "feishu",
    "text": "Grafana alert: payment callback timed out.",
    "messageId": "om_example",
    "messageType": "interactive",
    "senderType": "app",
    "truncated": false
  }
}
```

`source` and `text` are required. Text is trimmed, non-empty, and limited to 12,000 characters.
Optional metadata strings are trimmed and limited to 256 characters. Unknown fields make the
payload invalid. Invalid or inactive payloads are ignored by the receiver.

## Receiver behavior

The receiving a2wave instance:

1. validates transport activation, message activation, and the strict payload schema;
2. persists the complete value as `runSteps.input.context.referenced_message` for audit and replay;
3. restores it for reruns and job retries;
4. removes its body and unknown fields from the trusted `{{context}}` template view;
5. renders the body once in an XML-escaped `<referenced_context>` prompt section.

The receiver must never merge the body into the caller's trusted message, system prompt, or
authorization context. CardKit references that contain only a `card_id` remain unsupported because
they do not carry readable card content.
