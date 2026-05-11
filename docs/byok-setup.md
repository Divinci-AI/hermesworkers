# BYOK Setup

`hermesworkers` never ships a provider key. Every chat request runs against **your** API credentials, billed by **your** provider account. This guide explains how to wire each supported provider.

## Supported providers

| Provider     | Hermes model id format               | Get a key                                                  |
| ------------ | ------------------------------------ | ---------------------------------------------------------- |
| Anthropic    | `anthropic/claude-sonnet-4-5`, etc.  | <https://console.anthropic.com/settings/keys>              |
| OpenRouter   | `openrouter/<vendor>/<model>`        | <https://openrouter.ai/keys>                               |
| OpenAI       | `openai/gpt-4.1`, etc.               | <https://platform.openai.com/api-keys>                     |

You only need a key for the provider(s) whose models you want to call. Hermes routes to the provider based on the `model` prefix in each chat request.

## Push the secret

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # repeat for OPENROUTER_API_KEY / OPENAI_API_KEY
```

Wrangler asks for the value on the command line. The secret is stored encrypted on Cloudflare and only readable by your Worker at runtime.

## How the Worker uses it

On every container boot, the Worker:

1. Reads the secret from the Cloudflare environment.
2. Passes it to `startProcess('/usr/local/bin/start-hermes.sh', { env: {...} })`.
3. The startup script materialises `~/.hermes/.env` with the keys present in the environment.
4. Hermes loads `~/.hermes/.env` on launch and registers each provider whose key it finds.

The secret never lands in:

- the container image layers (it isn't baked in at build time),
- the Worker's deployed bundle (it's a runtime secret),
- Cloudflare logs (the Worker only reads it; it doesn't print it).

## Rotating a key

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # paste the new value
curl -X POST "$WORKER_URL/api/instance/restart-gateway" \
  -H "Authorization: Bearer $API_TOKEN"
```

`restart-gateway` keeps the container alive but tears down the Hermes processes so the next request reads the new `~/.hermes/.env`.

## Setting the default model

If a caller hits `/v1/chat/completions` without specifying a `model`, Hermes falls back to its default. Override it via:

```bash
# Plain env var in wrangler.toml [vars] section
[vars]
HERMES_DEFAULT_MODEL = "anthropic/claude-sonnet-4-5"

# Or push as a secret if you'd rather not commit the value
npx wrangler secret put HERMES_DEFAULT_MODEL
```

Common choices:

- `anthropic/claude-sonnet-4-5` — current Anthropic default.
- `openrouter/anthropic/claude-sonnet-4-5` — same model, billed through OpenRouter.
- `openai/gpt-4.1` — OpenAI flagship.

## Checking what Hermes sees

```bash
curl -s "$WORKER_URL/api/instance/logs" \
  -H "Authorization: Bearer $API_TOKEN" | jq -r '.stdout' | head -40
```

The "HERMES STATUS" section should show `✓` next to each provider whose key you've pushed. If you see `✗`, the secret isn't reaching `~/.hermes/.env` — re-check spelling and re-run `restart-gateway`.

## Using Cloudflare AI Gateway (optional)

Cloudflare AI Gateway can sit between Hermes and the upstream provider, giving you logging, caching and unified billing. To enable it, override the Hermes endpoint URLs in a forked `start-hermes.sh`:

```bash
hermes config set ANTHROPIC_BASE_URL "https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/anthropic"
hermes config set OPENAI_BASE_URL    "https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/openai"
```

You still need a valid provider key — AI Gateway forwards your credentials upstream and bills you the same way the provider would, plus the gateway's small fee.

See the [Cloudflare AI Gateway docs](https://developers.cloudflare.com/ai-gateway/) for details.
