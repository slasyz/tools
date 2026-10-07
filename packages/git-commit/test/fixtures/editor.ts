import { appendFileSync, writeFileSync } from "node:fs";

appendFileSync(process.env.TEST_EDITOR_LOG!, `${JSON.stringify(process.argv.slice(2))}\n`);
writeFileSync(process.argv.at(-1)!, process.env.TEST_EDITOR_MESSAGE || "");
process.exitCode = Number(process.env.TEST_EDITOR_EXIT || "0");
