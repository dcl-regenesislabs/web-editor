# SDK guidance for the web assistant

`sdk-skills.json` is generated from the Apache-2.0 licensed
[Decentraland SDK skills](https://github.com/decentraland/sdk-skills) repository.
Its metadata records the source commit and archive SHA-256; `LICENSE` is the upstream license.
The checked-in snapshot ships inside the service image. Startup needs no download.

To update, change the pinned revision in `../scripts/bundle-skills.mjs`, run
`node packages/service/scripts/bundle-skills.mjs` from the repository root, and review
the content changes. Then run `npm run validate` and the service Docker smoke test.

The bundle contains Markdown guidance and references only, without executable scripts
or symlinks. Scaffolding, deployment, migration, desktop MCP, issue submission, avatar
authoring and the standalone scene workflow are excluded from the skill catalog:
those workflows need tools this assistant does not have or conflict with the editor.
Their supporting references remain available for cross-skill links.

`read_skill` reads only documents in this bundle, with bounded paging and literal search.
It cannot read arbitrary service files, download assets or access project storage.
The web system prompt adapts examples to `src/scripts/`, browser tools and editor actions.

## Editor skills

Every folder here with a `SKILL.md` (today `scene-ui/`, `game-sounds/` and `game-feel/`) is the editor's own skill, written in this
repository. Both assistants read it: the web service layers it over the bundle at startup, and the
desktop app copies it over the downloaded SDK skills (`packages/desktop/src/skills.ts`, shipped as the
`editor-skills` resource). An editor skill can replace an SDK skill: `build-ui` loses its `SKILL.md` in
both places and keeps its references, which `scene-ui` links to.
