# Quickstart

This guide walks through deploying `hermesworkers` to a fresh Cloudflare account in roughly 10 minutes.

## Prerequisites

- A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (Sandbox containers require it).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 3.95.0 or newer.
- Docker Desktop (or compatible) running locally.
- An API key for **at least one** of: Anthropic, OpenRouter, OpenAI.

## 1. Clone and install

```bash
git clone https://github.com/PlaydaDev/hermesworkers.git
cd hermesworkers
npm install
```

## 2. Log into Cloudflare

```bash
npx wrangler login
npx wrangler whoami   # copy your Account ID
```

## 3. Configure `wrangler.toml`

Open `wrangler.toml` and replace the two placeholders:

```toml
name = "hermesworkers-yourname"    # any unique name in your account
account_id = "abcdef0123456789..."  # from `wrangler whoami`
```

Leave the rest as is for now (you can wire a custom dashboard hostname later — see [custom-domain.md](custom-domain.md)).

## 4. Push your provider API key(s)

You need **at least one** of these. Add more later if you want to mix providers.

```bash
# Pick one (or several)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENAI_API_KEY
```

Wrangler prompts you for each value; nothing is written to disk locally.

## 5. (Recommended) Push a Worker bearer token

Without an `API_TOKEN`, anyone who finds your `*.workers.dev` URL can use your provider key on your dime. Generate a random token and add it:

```bash
openssl rand -hex 32 | npx wrangler secret put API_TOKEN
```

If your shell can't pipe into `wrangler secret put`, just run it interactively:

```bash
openssl rand -hex 32     # copy the output
npx wrangler secret put API_TOKEN   # paste when prompted
```

## 6. Deploy

```bash
# Docker Desktop must be running — Cloudflare builds the container image locally.
npx wrangler deploy
```

The first deploy takes a few minutes while the Hermes image builds (~3 GB of Python deps). Subsequent deploys reuse layers and finish in seconds.

When the deploy completes, wrangler prints something like:

```
Deployed hermesworkers-yourname triggers (X.XX sec)
  https://hermesworkers-yourname.<your-subdomain>.workers.dev
```

## 7. Smoke test

```bash
WORKER_URL=https://hermesworkers-yourname.<your-subdomain>.workers.dev
TOKEN=<your API_TOKEN value>

# Health check
curl -s "$WORKER_URL/api/health" -H "Authorization: Bearer $TOKEN"

# First chat — expect 15–60 s cold start
curl -N "$WORKER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello, Hermes. Say one short sentence."}],
    "stream": true
  }'
```

You should get back an SSE stream of `data: {...}` chunks, with the final `data: [DONE]` marking the end of the response.

## 8. (Optional) Wake the container ahead of time

If you know a chat is coming and want to skip the cold-start wait, fire a wake call first:

```bash
curl -X POST "$WORKER_URL/api/instance/wake" \
  -H "Authorization: Bearer $TOKEN"
```

This boots the Hermes processes without sending a chat message, so the next request hits a warm gateway.

## Next steps

- Wire a custom hostname to expose Hermes' native dashboard — [custom-domain.md](custom-domain.md).
- Switch providers or run multiple models — [byok-setup.md](byok-setup.md).
- Understand how requests flow through the Worker — [architecture.md](architecture.md).
