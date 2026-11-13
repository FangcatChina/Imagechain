# Imagechain

Browser-side build orchestrator for container images.

## Quick start

```bash
pnpm install
pnpm dev
```

`pnpm build` writes a static bundle to `dist/` (`base: './'` in `vite.config.ts`, so it also
works from a subdirectory or `file://`). Without credentials the **Demo** provider runs on
simulated data.

## GitHub setup

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   Callback URL is your deployment URL, e.g. `https://<your-host>/`.
2. Deploy the relay. It holds both credentials, so the browser never sees them:

   ```bash
   npx wrangler deploy relay/cloudflare-worker.js --name imagechain-relay
   wrangler secret put GITHUB_CLIENT_ID      # OAuth App client ID
   wrangler secret put GITHUB_CLIENT_SECRET  # only for the OAuth2 web flow
   ```

3. In the app: **Sign in** → *Show OAuth settings*, set **Relay URL**
   (and API base `https://<relay>/api` if `api.github.com` is unreachable from your network).

The page only knows the relay origin. Device Flow, the `/oauth/authorize` redirect and the code
exchange are all finished by the Worker, which injects `client_id` / `client_secret` from its own
environment. Without a relay, use a fine-grained token (`Contents: read/write`,
`Actions: read/write`, `Metadata: read`) — it stays in `localStorage` and talks to
`api.github.com` directly.

## Project layout

```
src/core/      types, YAML config parsing, DAG, scheduler, store
src/plugins/   plugin contract, registry, github/, demo/
src/ui/        React components
relay/         optional Cloudflare Worker relay
examples/      sample pipeline YAML
```

## Notes

- Tokens live in `localStorage`; prefer a fine-grained token, or revoke the grant afterwards.
- Every poll costs an API request — lower `concurrency` or raise `pollIntervalMs` for large graphs.
