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
