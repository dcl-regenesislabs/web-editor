# Service security review — 2026-10-03

Reviewed the browser assistant, signed project storage, OAuth boundary, dependencies,
and single-process Node deployment. The fixes below are implemented on
`fix/service-security`, prepared against `ec8b763` and integrated with PR #89's
`a5f21df` base. No production deployment was performed.

## Findings and fixes

| Finding | Fix and regression coverage |
|---|---|
| Purge freed wallet quota without removing the underlying blob bytes. Repeated uploads could exhaust disk. | Reclaim unowned blobs after the grace period; preserve shared blobs and retained history. `packages/service/src/security.test.ts` covers both cases. |
| Failed uploads accumulated spent-ticket files faster than purge removed them, and purge reported completion with expired tickets remaining. | Cap retained tickets, reclaim expired entries on admission, and continue incomplete sweeps. Covered in `security.test.ts`. |
| Tokenless WebSocket upgrades could occupy capacity intended for legitimate tickets. | Validate the single-use ticket during the upgrade, before accepting the socket. `packages/service/src/ai/server.test.ts` covers tokenless admission. |
| Concurrent WebSocket handshakes could exceed the global connection cap. | Reserve capacity synchronously, counting pending and connected clients together. Covered in `ai/server.test.ts`. |
| Concurrent creation of different project IDs could bypass a wallet's project limit. | Serialize storage mutations and garbage collection under one process lock. Covered in `security.test.ts`. |
| Service dependencies included published vulnerabilities, including WebSocket fragmentation resource exhaustion. | Update the agent and transport dependencies and pin patched transitive dependencies. Test fragmented messages and verify the actual image's resolved versions. |

Additional controls include aggregate storage byte and object limits, a filesystem
free-space reserve, production wallet allowlists, bounded request bodies and
deadlines, strict HTTPS configuration, and an agent tool allowlist. The container
runs without root, with a read-only root filesystem and resource limits. The
experimental Worker adapter rejects public traffic.

Run the focused regression suite from the repository root:

```sh
npx vitest run packages/service/src/security.test.ts packages/service/src/ai/server.test.ts packages/service/src/ai/pi.test.ts packages/service/src/components.test.ts
```

## Verification

- `npm run validate`: passed lint, all package typechecks, 2,383 tests in 206 files,
  and scene, UI and desktop builds.
- Web build and Chromium smoke: passed all 25 checks, including signed assistant
  connection and browser tool calls with an injected test agent.
- Production service dependency audit: zero reported vulnerabilities at review time.
- Credential-pattern scan: no findings in the current source or reachable HEAD history.
  This is a heuristic check, not proof that every possible secret is absent.
- Docker smoke: passed signed storage, restart persistence, restricted-container
  operation, offline agent initialization and shutdown. The image resolved
  `ws` 8.22.0, agent 1.0.1 and the OpenAI client's `undici` peer 8.11.2.
- Nginx template: `nginx -t` passed with a temporary certificate and test hostname.
- Desktop runtime: boot and picker passed; engine console RPC timed out before
  the editor scene attached. Subsequent desktop checks did not run. The cause
  remains unresolved; this review does not establish that it predates these changes.

## Worlds management signing (host contract v1.2)

Host contract v1.2 ([HOST-CONTRACT.md](HOST-CONTRACT.md)) widens the signing boundary. Beside a .zone/.org Worlds server, the pinned editor can now get scene-shaped signatures (pathname only, metadata it chooses, e.g. `signer: decentraland-kernel-scene`) for the player's wallet on Worlds content, comms-gatekeeper, storage, multiplayer `/logs` and creators-data. Guards: exact per-environment host allow-list (no userinfo, ports, lookalikes or cross-environment), a method allow-list per service, multiplayer limited to GET `/logs`, the editor's own `dcl:editor` metadata refused there (so these signatures cannot be replayed at the project service), and a page dialog before a scene or whole-world undeploy. Other Worlds DELETEs (permissions, access lists) are not confirmed. A signature is replayable within each service's timestamp window, and since the query is unsigned, against any query on the same path and method. This still rests on L1: the editor is trusted like the HUD bundle.

## Deployment limits and remaining checks

Use the [Node deployment guide](../packages/service/README.md#container-deployment)
with one process and exclusive volume access. Deploy the updated browser and
service together: the WebSocket authentication protocol changed.

The droplet's actual firewall, TLS certificate, DNS, secrets and live OAuth/model
request have not been verified. Tests used synthetic credentials and did not call
a paid model. Start with explicit wallet allowlists; `*` intentionally admits any
wallet. Logical storage limits do not include filesystem allocation overhead.

Before public release, resolve or isolate the desktop runtime failure, run a live
assistant turn against the deployed HTTPS endpoint, and enable private vulnerability
reporting in the repository settings. See [SECURITY.md](../SECURITY.md) for release checks
and the trust boundaries. This review is not an independent penetration test.

## Mobile preview review — 2026-10-15

The mobile runtime source and graphics fixtures now live in the public
`dcl-regenesislabs/godot-web-preview` repository with its engine/explorer subtrees. The editor retains its
npm runtime package, hosting, transport and UI. No package, branch or deployment
was published during this review.

Fixed the resource relay's access to privileged realm routes: mobile scene workers
could borrow the editor window's service-worker identity to read environment or
server storage. It now permits only scene metadata, content and active-entity
lookups, with timeouts and bounded response buffering. Regression tests reject
environment/storage requests before fetch, along with traversal and wrong methods;
ten cases failed before the restriction. Tests use synthetic data, not secrets.

Also fixed preview launch cancellation, deferred runtime pausing until startup,
checked the complete npm artifact inventory before packing, and removed local
machine paths from the export. The migrated local static server now rejects path
and symlink escapes and streams assets. Exports import resources first and fail
on script/resource errors, including when Godot exits successfully.

Validation: after rebasing onto current main, editor `npm run validate` passed all six
checks and the explorer's 757 tests passed in the local timezone. The badge-date fixture
now uses a mid-month timestamp. Nine export, lifecycle, shader-build and server tests pass.
The service container builds with a verified mobile runtime and passes its restricted
container, signed-storage, restart and shutdown smoke test. That test also verifies
mobile Wasm delivery and denial of non-artifact files. Workflow syntax passes actionlint.

The final export loaded one scene worker and produced an inspected 1024×461 screenshot
with grass under the scene's parcels and mobile controls. Two open/close cycles kept
the Wasm heap at 494.75 MiB, with one scene worker each; this is not total browser RSS
or a long-duration memory test. Minimized preview: zero mobile GPU submissions over
three seconds. The editor returned to its closed-preview baseline: 71 engine frames
in three seconds, versus 15 while covered. Restore retained the instance and resumed
rendering. Detached-tab screenshots, gizmo movement, scene reload and undo also passed;
the scene's original transform was restored. A cold launch took 17.2 seconds, with
1,907 editor UI frames and a maximum frame gap of 59 ms during that sample.

A buffer-coherence fixture reproduced five stale-data failures on the old engine after
CPU updates, clears, copies, read-only shader use and a GPU write. The driver now submits
queued changes before readback, updates CPU mirrors and invalidates them before writable
shader use. Pending GPU reads return empty data instead of taking a synchronous fallback.
The clean engine build, native importer, browser library and all three fixture exports
pass. Linux Chromium passes buffer coherence, texture roundtrip and frame pacing against
the rebuilt engine; the pacing fixture measured 59 browser FPS while limiting the engine
to 4.98 FPS. Default native `cargo check --locked` and `cargo clippy --locked -- -D warnings`
pass. GDScript format/lint checks pass across 414 files. A headless regression verifies
content-loading guards on both main and worker threads. The final prepared npm runtime
passes artifact verification, and its rebuilt service image passes the restricted-container
smoke test. Native phone tests have not run. The embedded runtime still reports browser
permission rejections for service-worker registration and automatic pointer lock; neither
blocked these checks. Cold startup and the retained heap remain performance limitations.

Dependency review uses the downloaded public OSV npm database and an offline scanner;
no private dependency list is uploaded. The service's 91 production packages have no
reported vulnerabilities. The full editor lockfile has findings against 19 package
versions, all already present on main: older SDK/test-tool transitive packages and the
desktop Electron package. These are baseline maintenance findings, not introduced by
the mobile runtime. The public explorer's production npm audit also reported zero.
Local credential-pattern scans found no matches in changed source.

The browser runtime's 283 registry crates pass the offline OSV check after updates to
anyhow, bytes, keccak, protobuf, rand, Tokio and tracing-subscriber. Three maintenance-only
notices for core2, instant and multipart have explicit exceptions until November 15, 2026;
no vulnerability advisory is exempted. The full native Godot and Bevy lockfiles still
contain pre-existing RustSec findings; this does not establish that those runtimes are
vulnerability-free. Bevy's lockfile is unchanged, including findings in its browser graph
(crossbeam-epoch, quick-xml, ringbuf, ruint and ruzstd) that require separate dependency
upgrades. Browser isolation does not replace those upgrades.

Runtime releases now belong to `godot-web-preview`: its CI builds and audits the source,
runs graphics assertions, verifies the npm artifact inventory and publishes `next`
snapshots (every `main` push) and stable tags through npm OIDC. The editor's private hosting adapter depends on an exact runtime
npm version; its service image installs that package and verifies its manifest before
adding the editor transport. The editor has no source checkout, Rust/Godot build, source
credential or publishing workflow. Production dependency checks still use offline OSV;
the scanner binary is version-pinned and checksum-verified. Source-fork release workflows
remain disabled, and inherited distribution branch names are passed through environment
variables rather than interpolated into shell code.

The runtime repository publishes a `next` snapshot from every `main` push through npm
OIDC; the editor pins one exact snapshot version, and its lock entry carries the registry
integrity npm recorded at install time. Before merging a runtime bump, pass remote CI with
that lock entry. npm trusted-publisher setup belongs only in the source repository.

The distribution change passed editor validation (2,642 tests in 265 files and all
six gates), source packaging/release checks and workflow lint. A locally packed runtime
installed into the editor rendered the scene, grass and touch controls in an inspected
1024×461 capture. The service image built and passed its restricted-container smoke
using that tarball in an isolated build context; only that temporary context replaced
the registry URL with the local tarball and its measured integrity. Registry fetching
and OIDC publishing remain untested until the maintainer performs the first release.
