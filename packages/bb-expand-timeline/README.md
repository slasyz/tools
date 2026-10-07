# Expand Timeline

Expands BB timeline activity summaries and tool calls by default, including rows mounted while
scrolling or switching threads. You can still collapse and reopen them manually.
Choices stay in memory for the current app window and survive row remounts;
reloading the app or plugin resets them. Controls inside tool output, such as
argument truncation, remain under BB’s normal controls.

The content script is registered in `app.tsx` and implemented in `summary-defaults.ts`.
It uses BB’s internal row IDs (`:work-summary:`, `:tool:`, `:command:`, and other
tool activity kinds) and timeline header structure, so a BB update may require a
selector update.

## Requirements

- BB with the `bb` CLI on PATH, version 0.44 or newer and Plugin SDK 0.5.29 or newer.
- Node.js and the pnpm version configured in the repository's root `package.json`.
- A running BB server for install, reload, and development watch mode.

Run the commands below from `packages/bb-expand-timeline`. Use pnpm, not npm:
it uses the workspace and root `pnpm-lock.yaml`; `pnpm-workspace.yaml` already
includes this package.

## Install from this checkout

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
bb plugin install "$(pwd)"
bb plugin source bb-expand-timeline
bb plugin list
```

Review and accept BB's install prompt: plugins run with full trust. A local
install uses this directory in place, so keep the checkout at a stable path.
If the plugin was previously installed from another local directory, installing
the new path changes its source and keeps its configuration. This also fixes
the source path after moving the plugin into this repository.

The package name also determines the plugin ID: `bb-expand-timeline`. If you
still have the old `expand-timeline` registration, remove it after installing
the renamed package with `bb plugin remove expand-timeline`. This plugin stores
no persistent settings or expansion choices; removing the old registration leaves the local
checkout on disk.

Open a thread with an activity summary and tool calls to verify that they expand. Manually
collapsing it should keep it closed, even after scrolling away and back. Reopen
it with the same header. Nested tool calls expand too and can be collapsed
independently. Reloading the app or plugin should restore the expanded default.

## Update a local install

After pulling repository changes:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
bb plugin reload bb-expand-timeline
```

Local installs use the checkout's current files. Use build and reload, not
`bb plugin update`, which is for managed Git/npm sources.

## Development

Install the plugin locally first, then start the watch loop:

```bash
bb plugin dev .
```

BB rebuilds the frontend and reloads the plugin when sources change. Stop with
Ctrl+C. For a manual update, run the check, build, and reload commands above.

The package's `check` script also runs through the repository-wide
`pnpm --dir ../.. run check`. Format only this package when editing it:

```bash
pnpm exec oxfmt .
```

Run the DOM behavior tests with `pnpm test`.

After changing dependencies, run `pnpm install --no-frozen-lockfile` and commit
the manifest and root lockfile changes.

After a BB upgrade, check whether the SDK pin still matches the installed CLI:

```bash
bb plugin types . --check
```

If it reports a mismatch, run the same command without `--check`, review the
manifest changes, then install dependencies with `--no-frozen-lockfile` and
check, build, and reload again. The SDK dependency stays pinned to an exact
version.

## Enable or disable

```bash
bb plugin disable bb-expand-timeline
bb plugin enable bb-expand-timeline
```
