# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/heruruben-hub/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/heruruben-hub/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP, the REST v3 API, GraphQL v4, and an MCP server, all over one deterministic in-memory store. No database, no git binary, no network beyond the trial suite — the whole forge is TypeScript on the Node 22 standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (capability
  advertisement, `ls-refs`, `fetch` with shallow/deepen and thin packs) and the v0
  fallback, receive-pack v0 with `report-status` and sideband. Packs are built and
  read here — plain objects out, OFS/REF deltas in — with SHA-1 loose objects stored
  in memory. Pushes are fast-forward only: a non-fast-forward ref is refused per ref
  (`ng <ref> non-fast-forward`) while the fast-forward refs in the same push still land.
- **REST v3** (`/api/v3`): repositories, refs, branches, commits, contents (create,
  read, update with stale-sha 409, delete), labels, issues (with label validation and
  422s), issue comments, and pull requests with squash merge onto the default branch.
  Issues and pull requests share one number counter per repo, as GitHub does.
  Pagination uses absolute `Link: rel="next"` headers; every reply carries a
  non-empty `X-GitHub-Request-Id`; errors are JSON with a `message` string.
- **GraphQL v4** (`/api/graphql`): the documents `gh` and `github-mcp-server` send —
  viewer, repository fields, issues ordered by `CREATED_AT DESC`, cursor pagination,
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`,
  `node(id:)` with opaque Relay ids, `__type` introspection, and batched bodies
  answered in order. An unknown field is HTTP 200 with an `errors` array naming it;
  an unknown repository is `data.repository: null` with no errors.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via
  `server/discover` (with the 2025-11-25 `initialize` handshake as a fallback), and
  six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — acting on the same store as REST.

## Determinism

Every id, number and timestamp comes from a counter: a fixed epoch plus one second
per call, sequential repository/issue/comment ids, and Relay ids that are base64 of
stable type-and-number pairs. There is no `Date.now()`, no `Math.random()`, and no
random UUID anywhere in the stored or answered data, so a replayed trial exports
byte-identical state.

## Running it

```sh
# Node >= 22.18, no dependencies to install
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle: it binds an ephemeral port, registers it
with the env at `MAKEFUN_ENV_URL`, polls `/done`, and exits 0. `app.ts` is the
server; `store.ts` the in-memory store and git object model; `git.ts` the smart
HTTP wire; `rest.ts` the REST v3 surface; `graphql.ts` the GraphQL parser and
executor; `mcp.ts` the MCP endpoint.

Authentication is a Bearer token from `MAKEFUN_SHOP_TOKEN`. Without that variable
set, any non-empty Bearer is accepted (local development); a missing token is
always 401. `GET /healthz`, `GET /api/v3/` and `GET /api/v3/meta` are public.

## Testing locally

The kit's env (`program/env/server.mjs`) runs directly under Node — no Docker
needed — with `MAKEFUN_ENV_HOST`, `MAKEFUN_ENV_PORT`, `MAKEFUN_STATE_DIR` and
`MAKEFUN_SHOP_TOKEN` set. Start it, then start the entry with the same token and
`MAKEFUN_ENV_URL` pointing at the env; the env runs the 120 conformance checks and
the four timed workloads and writes `export/state.json` and `perf.json` into the
state dir. A quick smoke test without the env: start the server and hit
`GET /healthz`, then drive the surfaces with `curl` and the `git` CLI as a
smart-HTTP client.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry lifecycle: bind, register, poll `/done`, exit 0 |
| `app.ts` | HTTP server, routing, auth, request ids |
| `store.ts` | In-memory store, git object model, deterministic clock |
| `git.ts` | pkt-lines, packfiles, upload-pack v2/v0, receive-pack v0 |
| `rest.ts` | REST v3 resources and views |
| `graphql.ts` | GraphQL parser, executor, introspection, mutations |
| `mcp.ts` | MCP tools and JSON-RPC 2.0 handling |

## License

MIT — see [LICENSE](LICENSE).
