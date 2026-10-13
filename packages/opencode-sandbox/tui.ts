// Local-directory plugins resolve a root-level tui entrypoint, while published
// packages resolve the ./tui export. Keep both loading paths equivalent.
export { default } from "./src/tui.ts";
