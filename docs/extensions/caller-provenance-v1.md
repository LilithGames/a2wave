# Caller provenance extension v1

Extension URI:

`https://github.com/LilithGames/a2wave/blob/main/docs/extensions/caller-provenance-v1.md`

This optional A2A 1.0 extension carries the display provenance of an Agent-to-Agent call:

- the immediate calling Agent;
- the original user's display name, when an upstream channel identified one.

The values are caller assertions for run-history display and troubleshooting. They are not an
authenticated identity, an authorization input, or a replacement for A2A transport authentication.
Receivers must not populate authoritative `user_info`, grant permissions, or make policy decisions
from this extension.

## Discovery and activation

An a2wave Agent Card advertises the extension as optional:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://github.com/LilithGames/a2wave/blob/main/docs/extensions/caller-provenance-v1.md",
        "required": false
      }
    ]
  }
}
```

For Agent Card routes, the caller sends provenance only when the remote card advertises this URI.
For a direct A2A 1.0 endpoint, the separate caller-provenance setting must be explicitly enabled
because no card is available for capability discovery. The setting defaults to disabled, and direct
A2A 0.3 routes do not send the extension.

The request activates the extension in both places required by A2A 1.0:

- the `A2A-Extensions` HTTP header contains the URI;
- `params.message.extensions` contains the same URI.

The receiver reports activation in the response `A2A-Extensions` header.

## Message metadata

The payload is stored under the extension URI in `params.message.metadata`:

```json
{
  "https://github.com/LilithGames/a2wave/blob/main/docs/extensions/caller-provenance-v1.md": {
    "userName": "Alex Chen",
    "callerAgent": {
      "id": "agt_example",
      "name": "SDK Manager Agent"
    }
  }
}
```

All fields are optional individually, but the payload must contain `userName` or `callerAgent`.
`callerAgent` must contain `id` or `name`. String values are trimmed and limited to 256 characters.
Unknown fields make the payload invalid. Invalid or inactive payloads are ignored without failing the
A2A request.

Only display values are forwarded. The extension must not contain email addresses, phone numbers,
provider subject identifiers, access tokens, or the serialized upstream channel context.

## Run-history projection

The receiving a2wave instance stores the display values separately from authoritative identity data:

- `runs.trigger_user_name` receives the current authenticated channel's user display name when one
  exists; otherwise it receives the asserted `userName`;
- `runs.trigger_agent_name` receives `callerAgent.name`;
- `context.channel.user_info` remains `null` unless the current request established a real user through
  its authenticated channel.

Run rows render the known layers in order: `user · calling Agent · A2A`, `calling Agent · A2A`, or
`A2A`.
