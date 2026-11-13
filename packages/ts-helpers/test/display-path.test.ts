import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { displayPath } from "../src/display-path.ts";

test("shortens only the current home directory and its children", () => {
  const home = homedir();
  expect(displayPath(home)).toBe("~");
  expect(displayPath(join(home, "config", "file"))).toBe("~/config/file");
  expect(displayPath(`${home}-other/file`)).toBe(`${home}-other/file`);
  expect(displayPath(`/other${home}/file`)).toBe(`/other${home}/file`);
  expect(displayPath("relative/file")).toBe("relative/file");
  expect(displayPath("~/file")).toBe("~/file");
  expect(displayPath("")).toBe("");
});

test("shows paths inside cwd as relative paths", () => {
  const home = homedir();
  const cwd = join(home, "project");
  expect(displayPath(cwd, cwd)).toBe(".");
  expect(displayPath(join(cwd, "src", "file.ts"), cwd)).toBe("src/file.ts");
  expect(displayPath(join(cwd, "..file.ts"), cwd)).toBe("..file.ts");
  expect(displayPath(join(home, "other", "file.ts"), cwd)).toBe("~/other/file.ts");
  expect(displayPath(home, cwd)).toBe("~");
  expect(displayPath("relative/file.ts", cwd)).toBe("relative/file.ts");
  expect(displayPath("/elsewhere/file.ts", cwd)).toBe("/elsewhere/file.ts");
});
