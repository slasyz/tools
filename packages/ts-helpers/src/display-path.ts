import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Shorten a path for display only; never use the result for authorization.
 * With `cwd`, paths inside it become relative. Other paths under the home
 * directory start with `~`.
 */
export function displayPath(filePath: string, cwd?: string): string {
  if (cwd !== undefined && isAbsolute(filePath)) {
    const relativePath = relative(resolve(cwd), filePath);
    if (relativePath === "") return ".";
    if (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    ) {
      return withSlashes(relativePath);
    }
  }

  const home = homedir();
  if (filePath === home) return "~";
  const shortened = filePath.startsWith(`${home}${sep}`)
    ? `~${filePath.slice(home.length)}`
    : filePath;
  return withSlashes(shortened);
}

function withSlashes(filePath: string): string {
  return filePath.replaceAll(sep, "/");
}
