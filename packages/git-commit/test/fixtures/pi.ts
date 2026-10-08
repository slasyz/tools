import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
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
// A barrier makes benchmark tests fail if the calls run sequentially.
if (process.env.TEST_PI_WAIT_FOR_CALLS) {
  const expected = Number(process.env.TEST_PI_WAIT_FOR_CALLS);
  const deadline = Date.now() + 5_000;
  while (readFileSync(process.env.TEST_PI_LOG!, "utf8").trim().split("\n").length < expected) {
    if (Date.now() > deadline) process.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
if (process.env.TEST_PI_FAIL || process.env.TEST_PI_FAIL_MODEL === model) process.exit(1);
const modelOutputs: Record<string, string> = JSON.parse(process.env.TEST_PI_MODEL_OUTPUTS || "{}");
const text = modelOutputs[model] ?? outputs[history.length / 2] ?? outputs.at(-1)!;
history.push({ role: "user", text: request }, { role: "assistant", text });
writeFileSync(session, JSON.stringify(history));
const costs: unknown[] = JSON.parse(process.env.TEST_PI_COSTS || "[]");
const cost = costs[history.length / 2 - 1];
const message = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "Not a commit subject" }, { type: "text", text }],
  stopReason: "stop",
  usage: cost === undefined ? undefined : { cost: { total: cost } },
};
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
console.log(JSON.stringify({ type: "agent_end", messages: [message] }));
