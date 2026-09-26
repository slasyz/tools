# pi-sandbox

OS-level sandboxing and permission prompts for [Pi](https://pi.dev/) on macOS and Linux.
`read`, `write`, `edit`, and `pi-apply-patch` tool calls are checked in Pi. Bash and
`!cmd` use the reusable workspace package [`sandbox`](../sandbox/) and
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime).

## Install from a GitHub checkout

This is a private workspace package, not an npm release. Clone the repository,
install its workspace dependencies with `pnpm install`, then load the local Pi
package from that checkout:

```bash
git clone <your-repository-git-url> tools
cd tools
pnpm install
pi install "$(pwd)/packages/pi-sandbox"
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

`*.example.com` permits subdomains, **not** `example.com`; list the base
domain separately. Upstream rejects `"*"` in `allowedDomains`. Browser process
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

Prompts can abort, allow for this session, or save a rule in `~/.agents/sandbox.json`.
Prompts without a UI abort. Write grants also grant reads.
`denyWrite` always overrides `allowWrite`; it is never prompted. A grant that
still matches `denyWrite` produces a warning. `denyRead` is not a hard block
for the direct Pi read tool: a read grant adds the path to `allowRead`.

The extension registers `pi-apply-patch` for supported GPT models. Every
source and destination path in a patch is checked **before** preview reads or
changes start. If any path is denied, the entire patch is rejected.

## Attribution

Based on [Mario Zechner's Pi sandbox example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
and [Chris Arderne's pi-sandbox](https://github.com/carderne/pi-sandbox), both
under the MIT License. See [LICENSE](./LICENSE).
