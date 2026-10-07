import type { Action } from "../../src/input.ts";

import { main } from "../../src/commit.ts";
import { CommandError } from "../../src/process.ts";

const actions: Action[] = JSON.parse(process.env.TEST_ACTIONS || "[]");
process.exitCode = await main(process.argv.slice(2), {
  ask: async () => {
    const action = actions.shift();
    if (!action) throw new CommandError("stopped.", 130);
    return action;
  },
});
