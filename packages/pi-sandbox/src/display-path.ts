import { homedir } from "node:os";
import { sep } from "node:path";

/** Shorten a path for display only; never use the result for authorization. */
export function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
