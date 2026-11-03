export function preview(text: string, maxBytes = 12_000, maxLines = 200): string {
  const lines = text.split("\n");
  let output = lines.slice(0, maxLines).join("\n");
  if (Buffer.byteLength(output) > maxBytes) {
    output = Buffer.from(output)
      .subarray(0, maxBytes)
      .toString("utf8")
      .replace(/\uFFFD$/, "");
  }
  return output === text ? output : `${output}\n[Truncated; read output_file for the full result.]`;
}

export function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}
