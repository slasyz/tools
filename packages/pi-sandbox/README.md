# pi-sandbox

OS-level sandboxing and permission prompts for [Pi](https://pi.dev/) on macOS and Linux.
`read`, `write`, `edit`, and `apply_patch` tool calls are checked in Pi. Bash and
`!cmd` use the reusable workspace package [`sandbox`](../sandbox/) and
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime).

## Install from a GitHub checkout

This is a private workspace package, not an npm release. Run the commands below
from `packages/pi-sandbox` in a cloned repository checkout. Install the workspace
dependencies, then load the local Pi packages:

```bash
pnpm install
pi install "$(pwd)/../pi-apply-patch"
pi install "$(pwd)"
```

Keep the checkout and its `node_modules`: `pi-sandbox` resolves `sandbox` through
the pnpm workspace. Pi's direct `git:` install of the repository root is **not**
supported by this layout. The runtime requires Node >=20.11.0 and `rg` on PATH;
on Linux it also requires bubblewrap (`bwrap`) and other platform tools checked
at initialization. For example, install ripgrep with `brew install ripgrep` on
macOS or `sudo apt install ripgrep` on Debian/Ubuntu. Run Pi with access to
the same PATH as your shell.

## Configure

Settings come only from `~/.agents/sandbox.json`. Built-in defaults apply
when a setting is absent. An explicit `[]` turns off the default for that array.
See [`sandbox.json`](./sandbox.json) for a small sample.

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Set top-level `"allowGitCommonDir": true` so commits work in linked git
worktrees. If `allowRead` or `allowWrite` contains `"."`, that list also gets
the main worktree's `.git` directory. This also allows writes to that repo's
`.git/hooks` and `.git/config`. Default: `false`.

`*.example.com` permits subdomains, **not** `example.com`; list the base
domain separately. Use `example.com:443` or `*.example.com:8443` to permit only
that port; a rule without `:port` permits any port. Literal HTTP(S) URLs in bash
commands are checked using their destination port (80 or 443 by default).
Upstream rejects `"*"` in `allowedDomains`. Browser process
exceptions and unauthenticated SOCKS proxy options from the old fork are not
supported. Network restrictions apply to sandboxed subprocesses, not Pi's own
network requests.

## Use

```text
pi --no-sandbox                  disable sandboxing for this invocation
/sandbox                         show config and session allowances
/sandbox-enable                  enable for this session
/sandbox-disable                 disable for this session
/sandbox-allow domain <domain>   ask to allow a network domain
/sandbox-allow read <path>       ask to allow reads from a path
/sandbox-allow write <path>      ask to allow writes to a path
```

Terminal prompts use **✅ Allow** and **❌ Deny**, with bold access types,
highlighted paths, and vertical choices. Use ↑↓ to navigate, Enter to select,
and Esc to deny. Rule prompts also offer **🔓 Allow for all projects**, which
requires a second confirmation before saving to `~/.agents/sandbox.json`.
Tab edits the selected allow rule; Esc resets an edit, and Ctrl+C denies.
There are no letter hotkeys. Paths and commands wrap rather than truncate.
Prompts without a UI abort. In RPC mode, permission prompts use Pi's extension UI
protocol and time out after five minutes. The RPC client must handle
`extension_ui_request` records and send matching `extension_ui_response` records;
otherwise the request is denied when it times out. Write grants also grant reads.
In terminal mode, permission prompts report `state=blocked:kind=permission` through
[OSC 7501](https://www.superlogical.com/rex/docs/build/program-status), then
`state=working` when the prompt closes, including rejection or cancellation.
The `bash_unsandboxed` tool runs a command outside the sandbox only after explicit
user approval. Without a UI for approval, it does not run the command.
`denyWrite` always overrides `allowWrite`; it is never prompted. A grant that
still matches `denyWrite` produces a warning. `denyRead` is not a hard block
for the direct Pi read tool: a read grant adds the path to `allowRead`.

### Request access from the agent

The `sandbox_request_access` tool asks for one or more file/directory grants:

```json
{
  "requests": [
    { "path": "../shared/config", "access": "read" },
    { "path": "../output", "access": "write" }
  ]
}
```

One prompt offers **Allow** or **Deny** for the whole batch (up to 32 paths).
Grants last only for the current session runtime; they are never saved to config
or restored after reload/restart. Directory grants include descendants, and
write grants also permit reads. Relative paths use the session working directory;
`~` expands to the home directory. Paths must be literal, not glob rules.

The prompt shows symlinks as `requested path → resolved target`, including links
in parent directories. Approval permits access through the alias and directly
to the approved target. Grants store resolved targets, not dynamic symlink rules.
Targets are checked again after approval; a changed target requires a new request.
Hard write denies apply to both names and cannot be overridden.

Pi's terminal prompt highlights access types and paths; RPC prompts use plain
text. Missing UI, cancellation, timeout, or denial grants
nothing. Requests too large to display in full are rejected, not truncated.

The agent should request the narrowest access needed without asking separately
in chat, and prefer this tool to unsandboxed execution for filesystem access.
This tool does not run or retry an operation. Before retrying a failed operation,
check for partial changes; do not bypass a denied request with another tool.

## Authorization API

Other Pi extensions request filesystem access through the side-effect-free
`pi-sandbox/api` export:

```ts
import { requestSandboxAuthorization } from "pi-sandbox/api";

await requestSandboxAuthorization(pi.events, {
  source: "pi-multi-edit",
  cwd: ctx.cwd,
  accesses: [
    { kind: "read", path: "src/input.ts" },
    { kind: "write", path: "src/output.ts" },
  ],
});
```

Requesters must submit every planned access after validating their input and
before reading or changing files. A write grant also covers reads needed to
modify that path. The request waits for the sandbox policy decision. It rejects
if `pi-sandbox` is missing, disabled, not initialized, or denies any access.

`pi-apply-patch` uses this API for every source and destination path. It owns
the `apply_patch` tool registration, so both packages must be installed and
enabled. Pi does not load a dependency as a Pi extension.

The `apply_patch` tool reads and writes files in the Pi process. These direct
writes are not contained by the subprocess OS sandbox; the checks above are
the approval policy that controls them.
