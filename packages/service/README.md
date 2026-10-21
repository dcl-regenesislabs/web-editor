# @dcl-editor/service

Private project storage and an optional AI assistant for the web editor: a wallet's projects, synced between its devices
without publishing them. Files are stored by content hash, a project is a versioned manifest of
`path -> { hash, size }`, and a save made from a stale version is rejected.

The service never runs or renders anything a creator uploads. It stores bytes and hands them back
as `application/octet-stream` attachments.

One request handler, `handle(request, env)`, on web-standard APIs only. Behind it: a `BlobStore`
(get / put / head / delete / list) and a clock.

The Node service follows Decentraland's Well-Known Components structure, as in
`world-storage-service`: `src/components.ts` constructs typed dependencies,
`src/controllers/routes.ts` wires the router, and `src/service.ts` starts them
through `Lifecycle.run`. It uses `@dcl/http-server` and `@dcl/metrics` with the
Well-Known Components config and logger. Project storage, the assistant transport,
and the purge job are injected components. Shutdown cancels assistant turns, closes
WebSockets and HTTP, and waits for any running purge.

| Target | Store | Entry | State |
|---|---|---|---|
| Node 24 | a directory (`src/fs-store.ts`) | `dev-server.ts` | run and tested here |
| Cloudflare Workers | R2 (`src/r2-store.ts`) | `src/worker.ts` | run locally under `wrangler dev` (local R2); **never deployed** |
| tests | memory (`createMemoryStore`) | | |

## Run it locally

```bash
node packages/service/dev-server.ts --port 8787 --data <dir> --origin http://localhost:5230[,more]
# also: --host 127.0.0.1 (default)  --base-path /some/prefix
node packages/service/scripts/session.ts --url http://localhost:8787 --origin http://localhost:5230
npx vitest run packages/service      # from the repository root
```

For the assistant, inject `ANTHROPIC_OAUTH_SETUP_TOKEN` as a deployment secret, or
add `--ai-auth /absolute/path/.auth.json` for an existing pi OAuth session. The Node
entry point runs the agent loop and sends tool requests back to the browser; project
files stay in the browser's working copy. No shell or server workspace is exposed
to the model. Setup and validation: [Web assistant](../../docs/WEB-ASSISTANT.md).

Scene thumbnails come from an image model on a separate ChatGPT sign-in. Create its session file
once on a machine with a browser, copy it to the server outside `STORAGE_DIR` with mode 0600,
and set `AI_IMAGE_AUTH_PATH` to it; the service refreshes it in place:

```sh
npm run -w @dcl-editor/service image-login -- --out ~/image-auth.json
scp ~/image-auth.json server:/secrets/image-auth.json && ssh server chmod 600 /secrets/image-auth.json
```

The assistant includes the pinned [Decentraland SDK skills library](skills/README.md)
as a read-only component. It advertises the topic catalog and loads guidance on demand
through `read_skill`. The same bundle ships in Docker; no runtime network fetch is
required. Skills do not grant download, shell or private-storage access.

The assistant adds signed `GET /assistant/providers`, `POST /assistant/connect`,
and `/assistant/socket` WebSocket upgrades. These endpoints are Node-only; the
Cloudflare Worker continues serving project storage without the assistant.

Node 24 runs the `.ts` files as they are (type stripping), so there is no build. The dev server
makes its own ticket secret in development unless `TICKET_SECRET` is set; production requires a stable configured secret. It purges once at start and
then hourly. `session.ts` plays one wallet on two devices plus a stranger against a running server.

Local configuration belongs in `packages/service/.env`. The Well-Known Components
config provider loads that exact path regardless of the shell's working directory.
Injected environment variables take precedence over the file; CLI flags take
precedence over both. Environment files are ignored by Git and excluded from the
Docker build context.

Node also exposes `/health/live`, `/health/startup`, `/health/ready`, and
`/metrics` at the server root, independent of `BASE_PATH`. HTTP metrics use route
templates, keeping project IDs and upload tickets out of labels.
`WKC_METRICS_BEARER_TOKEN` requires a bearer token for metrics; with `NODE_ENV=production`
the service refuses to start without it.

## Who may call

Every `/projects…`, `/prefabs…` and assistant HTTP request is a Decentraland signed fetch (ADR-44): `x-identity-auth-chain-<n>`,
`x-identity-timestamp`, `x-identity-metadata`. The wallet is the auth chain's owner, lowercased.
A request is refused unless all of this holds:

- the chain verifies (`@dcl/crypto` `Authenticator.validateSignature`) for the text
  `<method>:<pathname>:<timestamp>:<metadata header as sent>`, lowercased;
- the chain is the login shape and nothing else: exactly `SIGNER` (the wallet) →
  `ECDSA_EPHEMERAL` (or `ECDSA_EIP_1654_EPHEMERAL`) → `ECDSA_SIGNED_ENTITY` (or
  `ECDSA_EIP_1654_SIGNED_ENTITY`). The ephemeral link's payload must read
  `<line>\nEphemeral address: 0x…\nExpiration: <ISO date>`, and that expiration must be in the
  future and at most `MAX_DELEGATION_DAYS` (31) away. A `SIGNED_ENTITY` right after `SIGNER`
  would delegate the wallet to a bare address with no expiry, so it is refused (`invalid-chain`);
- the timestamp is within 60 seconds of the service's clock;
- the metadata has `signer: "dcl:editor"` and `intent: "dcl:editor:projects"`;
- the metadata is not a scene's: `signer: "decentraland-kernel-scene"`, or any of `sceneId`,
  `parcel`, `realm`, `realmName` (what the engine adds for a scene or a scene's server), is refused
  with `scene-signed`;
- the metadata's `origin` is in the allowlist, and so is the `Origin` header when the browser sends
  one (it must equal the signed origin).

CORS answers only allowlisted origins, with that exact origin, and allows the `x-identity-*` headers.

`STORAGE_WALLETS` admits specific wallet addresses to storage, or `*` explicitly
opens storage to anyone who can generate a wallet. Production requires this policy.
`ASSISTANT_WALLETS` independently controls access to the paid assistant credential. Its capacity
is shared: 32 sockets (3 per wallet), 100 unused connect tickets (3 per wallet) and
`ASSISTANT_TURNS_PER_MINUTE` turns (10 per wallet). With `*`, a handful of free wallets can hold
all of it and lock everyone else out of the assistant, so list wallets when that matters.

Smart-contract wallets (ERC-1654 links) need a JSON-RPC endpoint in `ETH_RPC_URL`. Without it such
chains are refused (`contract-wallet-unsupported`). The path with it is written but was not run.

`pathname` is the path the service receives, including `BASE_PATH`. A proxy that rewrites the path
breaks signatures.

Errors are `{ "error": "<code>", … }`. 401: `unsigned`, `invalid-chain`, `delegation-expired`,
`delegation-too-long`, `timestamp-out-of-window`, `invalid-metadata`, `invalid-signature`,
`contract-wallet-unsupported`. 403: `scene-signed`, `wrong-signer`, `wrong-intent`,
`origin-not-allowed`, `invalid-ticket`, `ticket-used`. 429: `rate-limited`, `too-many-uploads`, `too-many-tickets`;
503: `busy`, `storage-full`, `ticket-capacity`; both with `retry-after`. A 500 is always `{ "error": "internal" }`; the cause is
only logged.

The assistant's HTTP routes go through the same signed-fetch checks (scene-signed and all), but
count against their own `ASSISTANT_REQUESTS_PER_MINUTE`, so assistant traffic never uses up a
wallet's saves. They take no body (`413 body-too-large`). The assistant's connection tokens are
random, single use and live 30 seconds in the assistant's memory; they share nothing with upload
tickets.

WebSocket upgrades must offer `dcl-assistant-v1` and `dcl-ticket.<token>` as
subprotocols. Only the first is echoed. The token is verified and capacity reserved
before upgrading. Deploy browser and service transport updates together.

## API

`version` counts from 1. `updatedAt` and `deletedAt` are ms since epoch.

| Request | Answer |
|---|---|
| `GET /projects` | `{ projects: [{ id, name, version, updatedAt, bytes, deletedAt? }], usage: { bytes, limit } }`, trash included |
| `GET /projects/:id/manifest` | `{ id, name, version, updatedAt, bytes, files: { [path]: { hash, size } } }`; 404 `not-found`, or `deleted` with `deletedAt` |
| `POST /projects/:id/uploads` `{ files: [{ hash, size }] }` | `{ uploads: [{ hash, url, method: "PUT", headers }], expiresAt }`, only for blobs this wallet has not stored; 413 `quota-exceeded` `{ used, needed, limit }`, `file-too-large`, `too-many-files` |
| `PUT <url>` with the bytes | 201 `{ hash, size }`; 422 `hash-mismatch` or `size-mismatch`; 403 `invalid-ticket`, `ticket-used`; 413 `quota-exceeded`, `too-many-blobs`; 429 `too-many-uploads`, `too-many-tickets`; 503 `busy`, `ticket-capacity` |
| `PUT /projects/:id/manifest` `{ name, files, baseVersion }` | `{ version, updatedAt }`. `baseVersion: null` creates. 409 `stale` `{ version, updatedAt }`; 409 `deleted`; 404 when `baseVersion` is set and there is no project; 422 `missing-blobs` `{ missing, count }`; 400 `invalid-path` `{ path, reason }`, `invalid-name`, `invalid-size`; 413 `too-many-files`, `too-many-projects`, `quota-exceeded` `{ used, needed, limit }` |
| `GET /projects/:id/files/:hash` | the bytes, only for a hash in that project's current manifest; else 404 |
| `DELETE /projects/:id` | `{ id, version, updatedAt, deletedAt, purgeAt }`; the project moves to the trash |
| `POST /projects/:id/restore` | `{ id, version, updatedAt }` |
| `GET /prefabs` | `{ prefabs: [{ name, updatedAt, bytes, files: { [path]: { hash, size } } }], usage: { bytes, limit } }`: the wallet's own prefab library |
| `POST /prefabs/:name/uploads` | as `POST /projects/:id/uploads` |
| `PUT /prefabs/:name/manifest` `{ files }` | `{ name, updatedAt }`. Creates only: 409 `exists`; 400 `invalid-prefab-name`; 413 `too-many-prefabs`, `quota-exceeded`; the rest as a project manifest |
| `GET /prefabs/:name/files/:hash` | the bytes, only for a hash in that prefab; else 404 |
| `DELETE /prefabs/:name` | `{ name }`; gone for good; its files go at the first purge after nothing else names them |
| `GET /health` | `{ ok: true }`, unsigned |

Order: content first, manifest last. A client that gets `missing-blobs` asks for uploads again.

Project ids match `/^[a-z0-9][a-z0-9-]{0,63}$/`, prefab names `/^[a-z0-9][a-z0-9_-]{0,63}$/`. A path is relative, `/`-separated, at most 512
characters, with no empty, `.` or `..` segment, no backslash or control character, no
`node_modules` or `.git` segment, and no segment starting with `.env`.

### Hashes

`hash` is the Decentraland content hash, what `@dcl/hashing`'s `hashV1` answers and what a Worlds
deployment uses. **That is `bafkrei…` (raw sha2-256) only up to 262,144 bytes. A larger file hashes
to `bafybei…`**, the root of a UnixFS tree over 256 KiB chunks. `packages/contract/src/cid.ts` computes it with
WebCrypto (`contentCid`, tested against `@dcl/hashing`), so it also runs in a browser.

An upload is accepted when its bytes match the hash either way: the content hash, or the raw
sha2-256 CID of the whole body (`bafkrei…` at any size, `rawCid`). Only the first can be reused
for a deployment.

### Uploads go through the service

`url` is the service's own `PUT /blobs/:hash?ticket=…`. The ticket is an HMAC over wallet, hash,
size and expiry (15 minutes) and stands in for a presigned url: the PUT carries no signed-fetch
headers. A ticket is good for one PUT: it is spent, with a create-only write of
`uploads/tickets/<expiry>.<wallet>.<hmac>`, before the body is read, whatever the outcome. A client that
gets `ticket-used` (or any 403/422) asks for uploads again.

The service reads the body into one buffer of exactly `size` bytes (a `content-length` that
differs is refused before reading), hashes it and stores it only when it matches. At most
`UPLOADS_PER_WALLET` uploads per wallet (`429 too-many-uploads`) and `UPLOAD_BYTES_IN_FLIGHT`
bytes in all (`503 busy`; one upload always gets through) are buffered at once. A body that
takes longer than `UPLOAD_TIMEOUT_SECONDS` plus its size at `UPLOAD_MIN_BYTES_PER_SECOND` is
dropped with `408 upload-timeout`, so a trickled upload cannot hold that budget.

Presigned R2 urls were not built, for three reasons:

- A presigned PUT can bind a sha2-256 checksum of the body, and the content hash of a file over
  256 KiB is not that.
- A wallet may reference only blobs it uploaded itself. With a direct-to-bucket upload the service
  never sees the bytes, so "this wallet holds this content" would need a per-wallet staging key
  and a finalize step that re-reads the object.
- The per-file limit (50 MB) should fit the Workers request body limit, which depends on the plan:
  confirm it before deploying.

The cost: uploads pass through the service, which buffers and hashes each file
(50 MB at most) within its memory and CPU limits.

## What is stored

```
blobs/<hash>                                       the bytes, once for everyone
wallets/<addr>/blobs/<hash>.<size>                 empty marker: this wallet uploaded that blob
wallets/<addr>/projects/<id>/manifest.json         the current version; its summary in object metadata
wallets/<addr>/projects/<id>/history/<version>.json   the last 20 versions
wallets/<addr>/prefabs/<name>.json                 a prefab in the wallet's library: its files, unversioned
uploads/tickets/<expiry>.<wallet>.<hmac>           empty: a spent upload ticket
purge/cursor.json                                  the last wallet the purge visited
```

`GET /projects` reads each project's `{ id, name, version, updatedAt, bytes, deletedAt }` from the
manifest's object metadata (R2 custom metadata; a `.meta/` sidecar on the filesystem) in one
listing; only a manifest written before summaries existed is read whole.

The marker carries the size in its key, so one listing answers what a wallet owns and each size.
A wallet's usage is those blob sizes plus the bytes of its manifests, their kept history and its prefabs, read
from a `bytes` field in each one's object metadata; a save that would pass the quota gets 413. A manifest may reference a hash only when the wallet's marker exists, whoever else
stored the same bytes.

A manifest write is compare-and-swap: on the store's etag (`put(..., { ifMatch })`; R2 `onlyIf`),
and under a shared storage mutation lock in the process. Upload commits, project creation,
trash changes and purge share that lock, so concurrent requests cannot bypass quotas or
race garbage collection. The filesystem store requires one process with exclusive volume access.

`purge(env)` deletes projects that spent `TRASH_DAYS` in the trash, markers that no manifest,
kept version or prefab references and that are older than a day (which is what gives quota back), and up
to 500 expired spent tickets. One run visits at most `PURGE_WALLETS_PER_RUN` wallets, reading one
manifest version at a time, and stores where it stopped; the next run carries on from there and
answers `done: true` once it reached the last wallet and drained expired tickets. At the end
of a sweep it removes blobs older than a day that no wallet owns, including orphans from
older service versions. Shared blobs and retained manifest history remain intact.
The Node service runs the runs back to back every hour. Empty filesystem directories are
removed too. A sweep holds the mutation lock while checking references and deleting bytes.

Node rebuilds global byte and object accounting from storage at startup. Both limits apply
across wallets, including failed-upload ticket files and manifest history; full storage returns
`503 storage-full`. Tickets also have a separate cap, per wallet (`429 too-many-tickets`) and global (`503 ticket-capacity`), and expired
tickets are reclaimed when admission reaches that cap. Deletion and purge retain room to run
at the logical quota. Filesystem writes keep a 256 MiB free-space reserve. Account for filesystem
block and directory overhead when sizing the volume; logical byte limits are not disk quotas.

## Configuration

`envFromVars(vars, store)` reads these (`process.env`, or Worker vars and secrets):

| Variable | Default | |
|---|---|---|
| `HTTP_SERVER_HOST` | `127.0.0.1` | Node bind address (`--host`) |
| `HTTP_SERVER_PORT` | `8787` | Node listen port (`--port`) |
| `STORAGE_DIR` | required on Node | filesystem store (`--data`) |
| `ALLOWED_ORIGINS` | required | comma-separated exact origins (`--origin` on the dev server) |
| `TICKET_SECRET` | required, 32+ characters | signs upload tickets (the dev server generates one) |
| `BASE_PATH` | none | path prefix the service is mounted under |
| `PUBLIC_URL` | from the request; required when `NODE_ENV=production` | base of upload urls, so they never echo the `Host` header |
| `WKC_METRICS_BEARER_TOKEN` | none: `/metrics` is open; required when `NODE_ENV=production` | bearer token `/metrics` asks for |
| `ETH_RPC_URL` | none | enables smart-contract wallets |
| `MAX_FILE_BYTES` | 52,428,800 (50 MB) | per file |
| `MAX_PROJECT_FILES` | 2,000 | per manifest and per uploads request |
| `MAX_WALLET_BYTES` | 524,288,000 (500 MB) | **the quota**: distinct blobs a wallet uploaded, plus its manifests and their history |
| `MAX_PROJECTS` | 100 | per wallet, trash included |
| `MAX_PREFABS` | 200 | prefabs in a wallet's library |
| `MAX_STORAGE_BYTES` | 5,368,709,120 (5 GiB) | Node global stored object bytes |
| `MAX_STORAGE_OBJECTS` | 100,000 | Node global object count, including manifests and tickets |
| `MAX_SPENT_TICKETS` | 50,000 | global retained spent tickets |
| `MAX_SPENT_TICKETS_PER_WALLET` | 4,000 | retained spent tickets per wallet; past it that wallet's uploads get 429 `too-many-tickets` |
| `STORAGE_WALLETS` | any wallet in development; required in production | comma-separated addresses, or explicit `*` |
| `HISTORY_VERSIONS` | 20 | manifest versions kept per project |
| `REQUESTS_PER_MINUTE` | 1,200 | per wallet, signed requests and uploads together |
| `TRASH_DAYS` | 30 | |
| `MAX_DELEGATION_DAYS` | 31 | longest an ephemeral login key may still be valid for |
| `MAX_WALLET_BLOBS` | 20,000 | distinct blobs per wallet (bounds every listing of its markers) |
| `UPLOADS_PER_WALLET` | 4 | blob uploads per wallet in flight at once |
| `UPLOAD_BYTES_IN_FLIGHT` | 268,435,456 (256 MB) | upload bytes buffered at once, per process (per isolate on Workers) |
| `UPLOAD_TIMEOUT_SECONDS` | 30 | base time an upload body may take |
| `UPLOAD_MIN_BYTES_PER_SECOND` | 65,536 | slowest upload accepted; adds size / rate to the base time |
| `ASSISTANT_REQUESTS_PER_MINUTE` | 60 | per wallet, assistant HTTP routes only |
| `PURGE_WALLETS_PER_RUN` | 20 | wallets one purge run visits |
| `ANTHROPIC_OAUTH_SETUP_TOKEN` | none | Node-only Claude setup token; seeds `.auth.json` in a sibling `.assistant` directory unless `--ai-auth` supplies its path |
| `SERVICE_VERSION` | none | the release this build is; `/health` reports it (the image sets it from the `SERVICE_VERSION` build arg) |
| `AI_AUTH_PATH` | none | existing OAuth session file (`--ai-auth`) |
| `AI_MODEL` | `claude-opus-5-5` | assistant model (`--ai-model`); the only model clients may use |
| `ASSISTANT_WALLETS` | any wallet; **required when `NODE_ENV=production`** and a credential is set | comma-separated wallets that may use the assistant, or `*` for any |
| `ASSISTANT_TURNS_PER_MINUTE` | 30 | assistant turns across all wallets |
| `ASSISTANT_TURNS_PER_DAY` | 50 | assistant turns per wallet per UTC day |
| `ASSISTANT_TURNS_AT_ONCE` | 2 | assistant turns one wallet may have running at once, across its tabs |
| `ASSISTANT_DAILY_LIMIT` | 50000 | internal allowance per wallet per UTC day, priced at the model's API rates; usage is not displayed in the editor |
| `ASSISTANT_WEEKLY_LIMIT` | 200000 | the same per week, from Monday 00:00 UTC |
| `AI_IMAGE_AUTH_PATH` | none | ChatGPT (Codex) OAuth session file for the image model behind `make_thumbnail` (`--ai-image-auth`); must be outside `STORAGE_DIR` in production. Unset, the assistant says thumbnails are unavailable |
| `ASSISTANT_IMAGES_PER_DAY` | 10 | thumbnail images per wallet per UTC day, counted in `image-usage/` beside that file |

Fixed in code: signed-fetch window 60 seconds, ticket lifetime 15 minutes, JSON body 2 MB, project
name 100 characters, path 512 characters, 3 auth-chain links, 500 spent tickets per purge run.

## For tests

`src/testing/wallet.ts` (`@dcl-editor/service/testing`): `createTestWallet({ origin, fetch?, now?,
owner?, validMinutes? })` makes a random account and an ephemeral key with `@dcl/crypto` and
answers `{ address, headers(method, url, overrides?), signedFetch(url, init?), anotherDevice() }`.
`signedFetch` has the host's shape; pass `fetch: (request) => handle(request, env)` to call the
handler without a server.

`src/testing/components.ts` starts the real component lifecycle on an ephemeral
port with an injected memory store and optional agent factory. Integration tests
cover signed uploads/downloads, CORS, health probes, metrics and shutdown during an
outstanding browser tool call.

## Container deployment

The Dockerfile is in this package; build from the **repository root** because the
service uses the shared contract and root lockfile:

```bash
docker build -f packages/service/Dockerfile -t dcl-editor-service:local .
node packages/service/scripts/docker-smoke.mjs
```

The image installs the exact mobile runtime npm version through the private hosting
adapter, verifies its artifact manifest and prepares the editor transport during the build.
It needs no Godot source checkout or source credential.

The image uses Node 24, production service dependencies, the non-root `node` user
(UID 1000), Tini, and a readiness healthcheck. The smoke script uses temporary
storage and synthetic configuration to test signed uploads/downloads, persistence
across restart, and clean shutdown. It removes its own container and volume.

For deployment, configure these values in `packages/service/.env` or inject them
through your secret manager. Use your real HTTPS origins (`ALLOWED_ORIGINS` is the page
that hosts the editor):

```dotenv
ALLOWED_ORIGINS=https://editor.example
PUBLIC_URL=https://service.example
TICKET_SECRET=<a random secret of at least 32 characters>
WKC_METRICS_BEARER_TOKEN=<a separate random metrics secret>
STORAGE_WALLETS=<your wallet address>
# only to offer the assistant; without a credential it answers 503 and the editor hides it
# ANTHROPIC_OAUTH_SETUP_TOKEN=<the output of claude setup-token>
# ASSISTANT_WALLETS=<your wallet address>
```

The image sets `NODE_ENV=production`, which makes the service refuse to start without
`PUBLIC_URL` (HTTPS, matching `BASE_PATH`), `WKC_METRICS_BEARER_TOKEN`, `STORAGE_WALLETS`,
HTTPS `ALLOWED_ORIGINS`, and, once a credential is set, `ASSISTANT_WALLETS`. Running Node
yourself, set `NODE_ENV=production` too, or none of those checks apply.

Then start the included Compose service:

```bash
docker compose -f packages/service/compose.yaml up --build -d
curl --fail http://127.0.0.1:8787/health/ready
docker compose -f packages/service/compose.yaml logs -f
```

Compose binds to localhost and keeps data in the named `editor-data` volume.
It runs with a read-only root filesystem, dropped capabilities, no privilege escalation,
a 1 GiB memory limit, two CPUs, 128 processes and bounded container logs. Only `/data`
and a 64 MiB temporary filesystem are writable. These limits contain resource abuse;
monitor rejected requests, free disk space and restarts.
Stop it with `docker compose -f packages/service/compose.yaml down`; omitting
`--volumes` preserves projects and OAuth sessions. For running Node directly,
also set `STORAGE_DIR` to an absolute writable directory or pass `--data`.

For Decentraland's deployed environments, publish this image to the chosen service
registry and configure the service with:

- One replica and a persistent writable volume at `/data`, owned by UID 1000.
  Filesystem locks, upload rate limits, connection tickets and running conversations are
  currently process-local. Use a stop-before-start rollout when sharing this volume.
- Port `8787`; `/health/ready` for readiness and `/health/live` for liveness.
- Inject `ALLOWED_ORIGINS`, `PUBLIC_URL`, a stable `TICKET_SECRET`, `WKC_METRICS_BEARER_TOKEN`
  and `STORAGE_WALLETS` from the deployment's configuration/secrets.
- The assistant is off until `ANTHROPIC_OAUTH_SETUP_TOKEN` (or `AI_AUTH_PATH`) is injected.
  The default OAuth file lives at `/data/.assistant/.auth.json`, outside project data;
  kept conversations, encrypted with keys only the creators' browsers hold, in `/data/.assistant/memory`.
  Back up `/data/projects` separately from credentials. Production rejects an explicit
  `AI_AUTH_PATH` inside `STORAGE_DIR`. With a credential, set `ASSISTANT_WALLETS`: the service
  refuses to start in production without it, because every turn spends the one configured credential.
- An HTTPS ingress that preserves paths and supports WebSocket upgrades.
  Set `PUBLIC_URL` to the external service URL (including `BASE_PATH`, if any)
  so upload URLs use HTTPS. Allow idle WebSocket connections for 15 minutes and
  give the container 30 seconds to shut down.
- Point the web host's `services.projects` at that same external URL.

On a droplet, expose only HTTPS and SSH through the firewall; keep `8787` on loopback.
The [Nginx example](nginx.conf.example) supplies TLS termination, request and connection
limits, upload bounds, and WebSocket forwarding. Replace its hostname and certificate
paths, verify with `nginx -t`, then check readiness through HTTPS. Keep `/metrics`
private and use its bearer token when collecting metrics locally.

`service-image.yml` builds and smoke-tests the image in CI. Registry publishing
and dev/prd rollout still require the service's registry name and infrastructure
registration; they are not wired to the desktop release workflow.

## Cloudflare deployment

**Experimental only; do not deploy publicly.** Distributed quotas, locks and safe shared-blob
garbage collection require a coordinator that this adapter does not implement. The production
security guarantees above apply to the single-process Node service.
The adapter rejects non-loopback URLs and requires `LOCAL_WORKER_EMULATION=true`
for local experiments; the example configuration cannot serve production traffic.

The Worker was run locally with `wrangler dev` (wrangler 4.147, miniflare's local
R2), outside this repository:

```bash
npm i --prefix <tools> wrangler
cp packages/service/wrangler.example.toml <dir>/wrangler.toml   # set `main` to this package's src/worker.ts
<tools>/node_modules/.bin/wrangler dev --config <dir>/wrangler.toml --port 8797 \
  --persist-to <dir>/state --test-scheduled \
  --var TICKET_SECRET:$(openssl rand -hex 24) --var ALLOWED_ORIGINS:http://localhost:5230 --var LOCAL_WORKER_EMULATION:true
node packages/service/scripts/session.ts --url http://127.0.0.1:8797 --origin http://localhost:5230
curl 'http://127.0.0.1:8797/__scheduled?cron=*/10+*+*+*+*'                 # one purge run
```

What that showed: `@dcl/crypto` (through `eth-connect`) bundles and runs on workerd with
`nodejs_compat`; R2 honours `onlyIf` as `If-None-Match: *` (create only) and as `etagMatches`
(both answer `null` when they do not hold); `list` with `delimiter`, `startAfter`, `limit` and
`include: ['customMetadata']` behaves as `scan` expects; with the in-process lock removed, three
concurrent creates and two concurrent saves on one version each let exactly one through; a 50 MB
upload passes. Local R2 is an emulation and `wrangler dev` does not enforce the deployed memory or
CPU limits, so the last point still has to be checked on the account.

### Requirements before a future Worker deployment

First implement shared admission control, quotas, locks and garbage collection
coordination. The following infrastructure checks do not replace that work.

- **Bucket.** Create the R2 bucket and bind it as `BUCKET`. Keep it private: no `r2.dev` public
  url and no custom domain on the bucket. Every read goes through the Worker's checks.
- **Secrets and vars.** `wrangler secret put TICKET_SECRET` (32+ random characters; rotating it
  voids the tickets out, nothing else). `ALLOWED_ORIGINS` lists the exact editor origins
  (`https://decentraland.org`, `https://decentraland.zone`, …), never a wildcard. Set
  `UPLOAD_BYTES_IN_FLIGHT` to what one isolate can hold (an isolate has 128 MB; `67108864` leaves
  room for one 50 MB upload) and confirm the plan's request body limit is above `MAX_FILE_BYTES`.
  `ETH_RPC_URL` only once smart-contract wallets have been tried.
- **Login key lifetime.** `MAX_DELEGATION_DAYS` (31) assumes the Decentraland login issues keys
  for about 30 days (the auth-server sign-in in `@dcl/linker-dapp` defaults to 30 days; the old
  web explorer used 7 days for wallets); that was not checked against a real identity. Decode the `Expiration:` of a
  fresh `auth.decentraland.org` identity first: if it is longer, raise the limit, or every save
  answers `401 delegation-too-long`.
- **Route.** Serve it from its own hostname (or a `BASE_PATH` that the route does not rewrite:
  signatures cover the path). Set `PUBLIC_URL` when the Worker's own url is not what clients
  reach, and point the web host's `services.projects` there.
- **Rate limits.** The in-code limiter, upload gate and locks hold per isolate only. Put a
  Cloudflare rate-limiting rule (or the Workers rate-limit binding) in front: per IP on
  `/projects*`, `/blobs/*` and `/assistant/*`, which also covers unsigned traffic.
- **Locks.** Manifest saves, deletes and restores do not need a Durable Object: each is a
  conditional write on the manifest's etag, so a racing save gets `409 stale`. What R2 alone
  does not serialize across isolates is the quota check at upload (`MAX_WALLET_BYTES`,
  `MAX_WALLET_BLOBS`), which can be overrun by the uploads racing it, and the per-wallet upload
  cap. If that matters, move `storeBlob`'s check behind a Durable Object keyed by wallet.
- **Cron.** Each trigger is one bounded purge run; schedule it often enough to cover every
  wallet within a day (`*/10 * * * *` with 20 wallets per run covers ~2,900 wallets a day).
  Watch the run's subrequests (R2 calls) against the plan's limit and lower
  `PURGE_WALLETS_PER_RUN` if a run nears it.
- **Assistant.** Not served by the Worker (`503 assistant-unavailable`); it is Node only.
- **After deploying:** run `scripts/session.ts --url <worker url> --origin <an allowed origin>`
  and trigger one scheduled run from the dashboard.

## Not done

- The Worker has run only under `wrangler dev`. Smart-contract wallets have never been verified.
- `blobs/<hash>` bytes are never deleted: purge removes projects and per-wallet markers only.
  Sweeping bytes needs a guard against a wallet re-uploading the same hash while it runs.
- The rate limits, the upload gate and the locks live in one process (one isolate on Workers):
  see the deployment checklist.
- A signed request can be replayed for 60 seconds by whoever sees its headers, and the signature does not
  cover the body. TLS is the protection.
- Any key pair is a wallet, a guest's included, so the quota is per wallet, not per person.
- No route reads or restores an old version; `history/` is kept for that.
- One purge run still reads every kept version of each wallet it visits (at most
  `MAX_PROJECTS` × (`HISTORY_VERSIONS` + 1) manifests), one at a time.
- A file that left the current manifest answers 404, so a device mid-download reads the manifest again.
- No range requests, no multipart uploads, no accounts or sharing between wallets.
