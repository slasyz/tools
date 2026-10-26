# opencode-sandbox

Sandbox plugin for **OpenCode V2**, tested with `2.0.28`, on macOS and Linux.
Uses the workspace [`sandbox`](../sandbox/) package and
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime),
with approval and command UX inspired by [`pi-sandbox`](../pi-sandbox/).

## Install from this checkout

Run these commands from `packages/opencode-sandbox`:

```sh
pnpm install
pwd
```

Add the printed **absolute package directory** to `plugins` in your global
`~/.config/opencode/opencode.jsonc` or your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/tools/packages/opencode-sandbox"],
}
```

Preserve any existing entries. The package's `./tui` export loads its terminal
commands and approval dialogs automatically. Keep the checkout and workspace
`node_modules`: this is a private package, not an npm release. Restart OpenCode
after installing. This targets V2, not the V1 plugin API.

Prerequisites on the **server machine**:

- Node **24+ recommended** (minimum 22.18, with native TypeScript support), on PATH.
- `rg` on PATH: `brew install ripgrep` on macOS.
- Linux additionally needs bubblewrap and the runtime's platform dependencies;
  on Debian/Ubuntu, start with `sudo apt install bubblewrap ripgrep socat`.
- The checked-in `src/worker.ts` must be executable. If your checkout lost that
  bit, run `chmod +x src/worker.ts`.

The sandbox runs on the OpenCode server, not on a remote client's computer.
OpenCode's separate remote-workspace execution backend is not supported.

## Configuration

Configuration is shared with Pi at **`~/.agents/sandbox.json`**, on the server.
Defaults and file-writing behavior come from the `sandbox` package. Missing
settings use defaults; `[]` explicitly removes an array's defaults.

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": ["."],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Relative filesystem rules resolve against the OpenCode Location directory,
not the shared server's cwd or an individual command's `workdir`. Approved file
rules are canonicalized and stored as absolute paths. Write grants imply read
grants. `denyWrite` and `deniedDomains` remain hard blocks even after an allow
grant. Direct file-tool reads require `allowRead` or `allowWrite`; an approved
read rule can override `denyRead`, as in Pi.

`*.example.com` matches subdomains, not the base domain. Include the base domain
separately. A `:port` suffix restricts a domain rule to that port. `"*"` is not a
supported network allow rule.

## Use

```text
/sandbox                         show config, enabled state, and session grants
/sandbox-enable                  enable checks for this session
/sandbox-disable                 disable checks for this session after confirmation
/sandbox-allow domain <domain>   request a network rule
/sandbox-allow read <path>       request a read rule
/sandbox-allow write <path>      request a write rule
```

Dialogs offer **allow for this session**, **edit the rule**, **abort**, or
**allow for all projects**. Global grants require an additional confirmation
and save to the shared Pi config. Edited rules must match the blocked target;
invalid rules abort the operation without saving them.

The `shell_unsandboxed` tool accepts the same arguments as OpenCode's `shell`
tool and requires fresh approval for **every invocation**, even in a disabled
session. OpenCode's native permissions still apply to approved operations.
Its tool description tells the model to prefer `shell`, request unsandboxed
approval through the tool rather than a separate chat question, and skip a trial
shell call when a sandbox restriction is already clear. Before retrying a failed
command, the model must check for partial changes and whether repeating it is safe.

A live TUI must be viewing the requesting session to approve new access.
Headless operations needing approval are denied immediately. Cancellation,
disconnect, plugin unload, and the five-minute prompt timeout never grant
access. Already allowed operations work without a TUI.

Session grants and enable/disable overrides are in memory, keyed separately by
session. They expire on plugin reload/server restart and are **not inherited by
child sessions**. Global rules are shared. Running shell commands keep the
policy snapshot taken at launch; later grants affect new commands only.

## Protection boundaries

- Each shell command gets its **own runtime worker and network proxies**.
  OpenCode still manages output, timeouts, cancellation, and background jobs.
  Runtime startup failures block the command—there is no unsandboxed fallback.
  Launcher aliases live under `~/.local/share/opencode-sandbox/workers`; this
  private directory is added to `denyWrite` in every enabled Location and cannot
  be granted through a prompt. Load the plugin from a trusted checkout that
  untrusted commands cannot modify.
- Direct `read`, `write`, `edit`, `patch`, `glob`, and `grep` tools receive policy
  checks before execution. Patch source/delete paths and rename destinations
  are checked before the native tool prepares its diff. Existing OpenCode
  permission asks/denies are never automatically loosened.
- Literal HTTP(S) destinations in tool shell commands can trigger preflight
  approval. Other network destinations are enforced by the OS/runtime proxy;
  use `/sandbox-allow domain …` after a denial. Failed commands are **never
  automatically retried** because they may already have made partial changes.
- OpenCode shell hooks lack a session ID. Calls outside the wrapped `shell`
  tool, including user shell messages/API shell calls, use **global policy
  only**: session grants and session disable do not apply to them.
- This does **not** sandbox the OpenCode server, arbitrary plugin code, MCP
  servers, PTYs/persistent terminals, formatters/LSP processes, file attachments,
  or OpenCode's own filesystem/network APIs. Search checks authorize the search
  root, not every descendant. Direct file-tool checks are application policy,
  not OS isolation, and do not eliminate filesystem races.
- Keep OpenCode's authenticated API inaccessible to sandboxed/untrusted code.
  Its administrative APIs and this plugin's approval RPC are trusted-client
  capabilities, not a second security boundary. Load only trusted plugins;
  later plugins can replace tool executors or shell hooks.

## Development

From this package directory:

```sh
pnpm check
pnpm test
OPENCODE_SANDBOX_INTEGRATION=1 pnpm test
```

The opt-in integration test needs `opencode` and the platform prerequisites.
It starts a private, authenticated server with an isolated home, checks RPC
loading and real OS read/write restrictions, then removes its own temporary
fixtures. It does not call a model or change your OpenCode/Pi settings.

API references used: [V2 plugins](https://opencode.ai/v2/docs/build/plugins),
[CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli), and
[plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc).
