import { Plugin } from "@opencode/plugin";

import { setupSandbox } from "./src/plugin.ts";

export default Plugin.define({ id: "opencode-sandbox", setup: setupSandbox });
