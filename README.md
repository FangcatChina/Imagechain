# Imagechain

Static-site CD/CI orchestrator for container image builds. It models every repository as a
node in a dependency graph, builds them in topological order (parallel where possible), and
tags + releases each repository only after its whole upstream chain succeeded.

Everything runs in the browser. There is no server component; Git platform access is a
plugin, so GitHub specifics never leak into the scheduler or the UI.

## Features

- **Dependency graph execution** – Kahn layering, cycle detection, per-level parallelism,
  upstream failures skip downstream nodes instead of building against stale images.
- **GitHub plugin via Device Flow** – plus OAuth2 web flow and personal access token.
  All auth strategies live behind `AuthProvider`, so another platform only needs a new plugin.
- **Manual publishing** – after a build, create a tag or publish a release from the repository
  drawer and type the tag and release title yourself. Notes list commits since the previous
  release.
- **Graph UI** – pan/zoom DAG with live status colors, ancestor/descendant highlighting,
  per-repository drawer with builds, run logs, latest release, tags, commits and the effective
  YAML config.
- **Demo provider** – simulated runs/releases so the UI works with no token and no network.

## Quick start

```bash
corepack enable
corepack pnpm install
corepack pnpm dev
```

Mainland China mirror:

```bash
corepack pnpm install --registry=https://registry.npmmirror.com
```

Build the static bundle:

```bash
corepack pnpm build   # output in dist/, deployable to any static host
```

`base: './'` is set in `vite.config.ts`, so `dist/` also works from a subdirectory or `file://`.

## GitHub setup

### 1. Create an OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

- Homepage URL: your deployment URL
- Authorization callback URL: `https://<your-host>/` (used by the OAuth2 web flow)

Copy the **Client ID**. The client secret is only needed for the OAuth2 web flow.

### 2. Deploy the relay (required for Device Flow in a browser)

Browsers cannot call `github.com/login/*` directly: those endpoints return no CORS headers
(`api.github.com` does, which is why REST calls work without a proxy). Device Flow therefore
needs a tiny relay that forwards two POSTs. No secret is involved.

```bash
npm i -g wrangler
wrangler deploy relay/cloudflare-worker.js --name imagechain-relay
wrangler secret put GITHUB_CLIENT_ID     # optional, if you do not send client_id from the SPA
wrangler secret put GITHUB_CLIENT_SECRET # only for the OAuth2 web flow
```

Then open the app → provider **GitHub** → **Sign in** → *Show OAuth settings* and set:

| Field | Value |
| --- | --- |
| OAuth client ID | `Iv1.xxxxxxxx` |
| Relay URL | `https://imagechain-relay.<account>.workers.dev` |
| API base | `https://api.github.com` (set to `https://<relay>/api` if GitHub API is unreachable from your network) |

Routes exposed by the relay:

| Route | Purpose |
| --- | --- |
| `POST /device/code` | proxies GitHub device authorization request |
| `POST /oauth/access_token` | polls the device code |
| `POST /oauth/exchange` | Authorization Code exchange (needs `GITHUB_CLIENT_SECRET`) |
| `ANY /api/*` | optional REST proxy for restricted networks |

Defaults can also be baked at build time: `VITE_GITHUB_CLIENT_ID`, `VITE_OAUTH_RELAY`.

### 3. Alternative: personal access token

Provider **GitHub** → **Access token**, paste a fine-grained token with *Contents: read/write*,
*Actions: read/write*, *Metadata: read*. The token stays in `localStorage` of that browser.

Scopes used by Device Flow / OAuth2: `repo workflow read:user`.

## Pipeline definition

The DAG is stored as a single YAML document in `localStorage`, but you never have to edit it by
hand: repositories, workflows and dependencies are managed through the in-app editor
(**+ Add image**, **Edit**, **Rules**). Saving rewrites the document and re-validates the graph,
so the file format stays the source of truth for tooling while the UI stays interactive.

```yaml
version: 1
provider: github
branch: main
concurrency: 2

repos:
  - key: base-image
    repo: acme/base-image
    description: Base runtime image
    workflows:
      - file: build-image.yml
        inputs:
          platform: linux/amd64
    tag:
      template: "v{date}.{seq}"
    release: true

  - key: api-image
    repo: acme/api-image
    dependsOn: [base-image]
    workflows:
      - file: build-image.yml
      - file: smoke-test.yml
        optional: true
```

| Field | Notes |
| --- | --- |
| `provider` / `defaults.provider` | plugin id, default `github` |
| `branch` | default ref for dispatches and commit queries |
| `concurrency` | max repositories building in parallel within one dependency level |
| `repos[].key` | unique node id used by `dependsOn` |
| `repos[].repo` | `owner/name` |
| `repos[].url` | optional, defaults to the GitHub clone URL |
| `repos[].workflows` | strings or objects: `file`, optional `ref`, `inputs`, `optional` |

Execution semantics:

1. Repositories are grouped into levels; a level only starts when every previous level finished.
2. A node whose upstream build failed is marked `skipped` and never dispatched.
3. Workflows within a node run sequentially; `optional: true` failures do not fail the node.
4. Plans only build. Tagging and releasing are explicit actions: click **Tag** or **Release** in
   the repository drawer and type the tag / release title, or use **Batch publish** to apply one
   tag (and release title) to any subset of repositories.
5. Before any plan runs, nodes show the **last known state fetched from the provider**
   (latest workflow runs), not a local placeholder.

## Plugin API

`src/plugins/types.ts` is the entire contract. A new platform implements
`GitProviderPlugin`:

```ts
interface GitProviderPlugin {
  id: string;
  label: string;
  accent: string;
  requiresAuth: boolean;
  auth: AuthProvider | null;
  createClient(credential: Credential, options?: { apiBase?: string }): GitProviderClient;
  repoUrl?(ref: RepoRef): string;
}

interface GitProviderClient {
  viewer(): Promise<ViewerInfo>;
  repository(ref: RepoRef): Promise<RepositoryMeta>;
  listBranches(ref: RepoRef): Promise<string[]>;
  workflow(ref: RepoRef, file: string): Promise<WorkflowInfo | null>;
  dispatchWorkflow(ref: RepoRef, file: string, opts: { ref: string; inputs? }): Promise<void>;
  latestRunId(ref: RepoRef, file: string): Promise<string | null>;
  run(ref: RepoRef, runId: string): Promise<RunInfo>;
  latestRelease(ref: RepoRef): Promise<ReleaseInfo | null>;
  tags(ref: RepoRef): Promise<TagInfo[]>;
  commits(ref: RepoRef, opts: { since?: string; branch?: string; limit?: number }): Promise<CommitInfo[]>;
  createTag(ref: RepoRef, tag: string, sha: string, message?: string): Promise<void>;
  createRelease(ref: RepoRef, input: { tag; name; body; draft; prerelease }): Promise<ReleaseInfo>;
}
```

`AuthProvider` advertises which strategies it supports (`device-flow`, `oauth-web`, `pat`) and
supplies the flow implementations. Register the plugin in `src/plugins/registry.ts`; nothing
else changes. `src/plugins/github` is the reference implementation, `src/plugins/demo` shows a
provider with `requiresAuth: false` and a stateful fake backend.

## Project layout

```
src/core/        types, YAML config parsing, DAG, scheduler, store
src/plugins/     plugin contract, registry, github/, demo/
src/ui/          App, GraphView, RepoDetail, AuthModal, ConfigModal
relay/           single-file Cloudflare Worker (optional)
examples/        sample pipeline YAML
```

## Notes

- Tokens are stored in `localStorage`; anyone with access to the browser profile can read them.
  Prefer a fine-grained token, or use Device Flow and revoke the grant afterwards.
- Rate limits apply: every poll costs a request. Lower `concurrency` or raise
  `pollIntervalMs` in `PlanRunner` options for very large graphs.
- Logs open in the platform UI (`run.html_url`). Fetching raw job logs needs a signed redirect
  URL, so it is intentionally not proxied.
- Graph layout is layered by dependency depth; use the mouse wheel, drag, or **Fit**.
