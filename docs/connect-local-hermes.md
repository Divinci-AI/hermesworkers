# Connecting a local Hermes (or any OpenAI client) to a hosted agent

A Divinci-hosted Hermes agent exposes a **customer-facing proxy URL** plus a
per-agent API key (`hsk-…`). Drop them into a local Hermes, the Hermes desktop
app, or any OpenAI-compatible client to drive the cloud agent from your machine.

- **Base URL:** `https://<divinci-api-host>/api/v1/hermes-proxy`
- **API key:** the agent's `hsk-…` key (from the Hermes Agents page, or the
  create/regenerate API). Sent as `Authorization: Bearer hsk-…`.

The proxy resolves the agent from the key and forwards the **entire** Hermes API
surface (`/v1/chat/completions`, `/v1/responses`, `/v1/models`,
`/v1/capabilities`, `/v1/runs/*`, `/api/sessions/*`, `/health`) to that agent's
isolated container. Your key is never forwarded upstream.

## 1. Any OpenAI-compatible client (Open WebUI, LibreChat, ChatBox, SDKs)

Point the client's OpenAI base URL at `…/api/v1/hermes-proxy/v1` and use the
`hsk-…` key as the API key. Example with the OpenAI Python SDK:

```python
from openai import OpenAI
client = OpenAI(
    base_url="https://api.divinci.app/api/v1/hermes-proxy/v1",
    api_key="hsk-xxxxxxxx",
)
resp = client.chat.completions.create(
    model="hermes",                # any value; the agent's own model is enforced
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
```

## 2. Local Hermes gateway → proxy mode (`GATEWAY_PROXY_URL`)

Run Hermes locally but let the **hosted** agent do the work. Configure your local
gateway to forward all messages to the hosted agent:

```bash
hermes config set GATEWAY_PROXY_URL "https://api.divinci.app/api/v1/hermes-proxy"
hermes config set API_SERVER_KEY "hsk-xxxxxxxx"
hermes gateway
```

Your local gateway now forwards every turn to the hosted agent's container.

## 3. Hermes desktop app (remote backend)

The desktop app can point at a remote backend instead of managing its own:

```bash
export HERMES_DESKTOP_REMOTE_URL="https://api.divinci.app/api/v1/hermes-proxy"
```

or set it in the app's **Gateway settings** panel, and sign in with the `hsk-…`
key. (The desktop app's native dashboard/WebSocket path is a follow-up — the
OpenAI/gateway-proxy paths above work today.)

## Notes

- **Rotate/revoke:** regenerating the key (`POST …/hermes-agent/:id/regenerate-key`)
  invalidates the old one immediately.
- **Multi-user sessions:** pass `X-Hermes-Session-Key` to isolate concurrent
  callers within one agent; it is forwarded through the proxy.
- **The agent's model + system prompt win.** The proxy/worker configure the
  container with the agent's stored persona and model, so a client-supplied
  `model` is advisory.
