import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const request = readFileSync(args.at(-1)!.slice(1), "utf8");
const history: { role: string; text: string }[] = existsSync(session)
  ? JSON.parse(readFileSync(session, "utf8"))
  : [];
const outputs: string[] = JSON.parse(process.env.TEST_PI_OUTPUTS || '["Generated subject"]');
appendFileSync(
  process.env.TEST_PI_LOG!,
  `${JSON.stringify({ args, session, request, history })}\n`,
);
if (process.env.TEST_PI_FAIL) process.exit(1);
const text = outputs[history.length / 2] ?? outputs.at(-1)!;
history.push({ role: "user", text: request }, { role: "assistant", text });
writeFileSync(session, JSON.stringify(history));
console.log(text);
