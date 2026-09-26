# sandbox

Reusable configuration, permission checks, and runtime operations for
`@anthropic-ai/sandbox-runtime`. This private workspace package contains no
Pi or OpenCode dependencies. macOS and Linux adapters can import its public
`index.ts` exports.

```ts
import {
  loadConfig,
  resolveAllowances,
  initializeSandbox,
  wrapWithSandbox,
  cleanupAfterCommand,
  resetSandbox,
} from "sandbox";

const config = loadConfig();
const allowances = { domains: [], readPaths: [], writePaths: [] };
if (config.enabled) await initializeSandbox(config, allowances);
// The host supplies a shell and runs the wrapped command with its own process adapter.
const wrapped = await wrapWithSandbox(command, shell);
// After that child exits: cleanupAfterCommand();
// On shutdown: await resetSandbox();
```

Configuration is read only from `~/.agents/sandbox.json`; absent settings use
built-in defaults. Config writers accept one file path and add one rule without writing defaults.
`resolveAllowances` merges session rules without mutating config; writes imply
reads. The runtime wrapper does not spawn processes or prompt users: the host
handles its own shell, UI, timeouts, aborts, and process cleanup.

Based on [Chris Arderne's pi-sandbox](https://github.com/carderne/pi-sandbox),
under the MIT License; see [LICENSE](./LICENSE).
