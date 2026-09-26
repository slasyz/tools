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

const config = loadConfig(globalConfigPath, projectConfigPath);
const allowances = { domains: [], readPaths: [], writePaths: [] };
if (config.enabled) await initializeSandbox(config, allowances);
// The host supplies a shell and runs the wrapped command with its own process adapter.
const wrapped = await wrapWithSandbox(command, shell);
// After that child exits: cleanupAfterCommand();
// On shutdown: await resetSandbox();
```

Hosts supply the two JSON file paths. Layered arrays combine in global-then-
project order and fall back to defaults only if both layers omit them. Config
writers accept one file path and add one rule without writing defaults.
`resolveAllowances` merges session rules without mutating config; writes imply
reads. The runtime wrapper does not spawn processes or prompt users: the host
handles its own shell, UI, timeouts, aborts, and process cleanup.

Based on [Chris Arderne's pi-sandbox](https://github.com/carderne/pi-sandbox),
under the MIT License; see [LICENSE](./LICENSE).
