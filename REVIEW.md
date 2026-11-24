# Review

What a reviewer of this repository checks, human or agent. Read with [AGENTS.md](AGENTS.md)
(where a change goes, the loop) and [ARCHITECTURE.md](ARCHITECTURE.md) (the four layers and the
contract). The steps to run the editor are in the [verify skill](.claude/skills/verify/SKILL.md).

Tag each finding `P0` (wrong, unsafe or unproven: blocks), `P1` (a real bug, a broken contract or
missing evidence: blocks), `P2` (worth noting) or `Pre-existing` (not this diff). Anchor it to a
file and line and say what to do instead. No style nits. A review that finds nothing says so in
one line. A review is of one commit: say which.

## Every pull request

- The body says what was run and what was not. A claim with no observed evidence (command
  output, a screenshot, a log line) is unproven.
- `npm run validate` passed on the head commit. A change to runtime behaviour either ran
  `npm run validate:e2e` or says why it could not.
- A bug fix ships a reproduction or a test that fails before and passes after.
- Anything a person sees has a before and an after screenshot of the same screen, taken from the
  running editor on a hardware GPU, not described from the code. A screenshot from a software
  renderer or of a different screen is not evidence.
- New tests are few and test behaviour, not implementation. A flaky test is fixed or removed,
  never retried.
- Every commit on `main...HEAD` belongs to this change.
- No secrets, machine paths or private repository names in tracked files.

## The layers

- **The engine is stock upstream.** No forks, patches or vendored engine code: a capability the
  editor needs is built scene-side or proposed upstream.
- **`packages/contract` is the source of truth** for the message bus and the IPC shell. A change
  to a message has both ends changed in the same pull request and the contract's types updated.
- **A change lives in the package that owns it** (the table in AGENTS.md). Editor logic in the
  explorer, or explorer logic here, is a finding.
- State that two processes share is synchronised through the documented path, not a new side
  channel.

## The web editor and the service (`packages/web`, `packages/service`)

- Read [docs/WEB-EDITOR.md](docs/WEB-EDITOR.md) for how a change reaches players; a change to the
  host contract names the explorer commit it was checked against.
- The assistant authenticates with an OAuth session, never an API key.
- A scene's code and assets are untrusted input: check what a hostile scene can make the editor
  or the service do, and what crosses the fetch bridge.
- The trust boundaries and release checks in [SECURITY.md](SECURITY.md) still hold.

## Security pass

Separately from correctness: injection (shell, path, HTML), anything user- or scene-controlled
reaching a file path, a URL fetch or `innerHTML`; authentication and authorisation on service
routes; tokens or sessions written to disk or logs; new dependencies and install scripts; changes
to workflows, release or publishing steps.
