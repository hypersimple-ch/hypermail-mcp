---
name: updatenpm
description: Release hypermail-mcp to the upstream npm registry and push the matching Git commit and tag. Use when asked to update, publish, or release the hypermail npm package, including patch, minor, or major releases.
compatibility: Requires npm and pnpm, npm publish access to hypermail-mcp, and Git push access to the origin repository.
---

# Release hypermail-mcp to npm

Accept an optional release level: `patch`, `minor`, or `major`. Default to `patch`. Reject any other value.

## Safety and prerequisites

1. Run from the `hypermail-mcp` repository root.
2. Inspect `git status --short`, the current branch, and configured `origin`. Do not release from a dirty worktree or an unexpected branch without asking the user.
3. Confirm the local branch is synchronized with its upstream.
4. Check `npm whoami` and verify that `npm view hypermail-mcp version` matches the latest release expected from the Git tags.
5. Show the proposed version and release steps, then obtain explicit user confirmation immediately before commands that publish to npm or push Git refs.

## Release workflow

1. Find the latest release tag and review changes since it:

   ```bash
   git describe --tags --abbrev=0
   git log --oneline "$(git describe --tags --abbrev=0)..HEAD"
   ```

2. Update the release summary near the top of `README.md` with relevant user-facing features and fixes. Do not include unrelated maintenance changes. Commit this documentation update before continuing so `npm version` starts from a clean worktree.

3. Bump the version:

   ```bash
   npm version <patch|minor|major>
   ```

   This updates `package.json`, creates a release commit, and creates the matching `v<version>` Git tag. Verify the version, commit, and tag before publishing.

4. Publish:

   ```bash
   npm publish
   ```

   Do not separately skip validation: the package's `prepublishOnly` script runs `pnpm check`, which runs tests, typechecking, and the production build. Stop and report the failure if validation or publishing fails. Never push an unpublished release tag.

5. After npm publication succeeds, verify the published version:

   ```bash
   npm view hypermail-mcp version
   ```

6. Push the release commit and tag:

   ```bash
   git push --follow-tags origin HEAD
   ```

7. Report the published npm version and pushed Git tag.

## Failure handling

- If `npm version` succeeds but publishing fails, leave the release commit and tag local and report the exact recovery state; do not invent a new version or push.
- If publishing succeeds but Git push fails, clearly report that npm is already live and retry only the Git push after resolving the issue.
- Never reuse or overwrite an already-published npm version or a remote Git tag.
