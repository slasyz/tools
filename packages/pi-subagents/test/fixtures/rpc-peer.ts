import { StringDecoder } from "node:string_decoder";

const emit = (record: object) => process.stdout.write(JSON.stringify(record) + "\n");
let buffer = "";
const decoder = new StringDecoder("utf8");
let output: Promise<unknown> = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const record = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (record.type === "echo") {
      const bytes = Buffer.from(
        JSON.stringify({
          type: "response",
          id: record.id,
          success: true,
          data: { text: record.text },
        }) + "\n",
      );
      // Deliberately split a multi-byte character across data chunks.
      const split = bytes.indexOf(Buffer.from("😀")) + 1;
      output = output.then(async () => {
        process.stdout.write(bytes.subarray(0, split));
        await new Promise<void>((resolve) => setImmediate(resolve));
        process.stdout.write(bytes.subarray(split));
      });
    } else if (record.type === "error") {
      emit({ type: "response", id: record.id, success: false, error: "rejected" });
    } else if (record.type === "exit") {
      process.stderr.write("crash detail\n");
      process.exit(3);
    } else if (record.type === "malformed") {
      process.stdout.write("not json\n");
    } else if (record.type === "dialog") {
      emit({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Allow?" });
      emit({ type: "response", id: record.id, success: true });
    } else if (record.type === "ignore-term") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 10_000);
      emit({ type: "response", id: record.id, success: true });
    }
  }
});
