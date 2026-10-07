export const MODELS = [
  "opencode-go/gpt-6-luna",
  "opencode/claude-haiku-5-5",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/gpt-5.6-luna",
  "openrouter/google/gemini-3.8-flash",
  "openrouter/inception/mercury-2",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/hy3",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-5.6-luna",
  "opencode-go/minimax-m3",
  "openrouter/anthropic/claude-haiku-4.5",
  "openrouter/openai/gpt-oss-120b",
] as const;

export const BENCHMARK_MODELS = [
  "opencode-go/gpt-6-luna",
  "openai-codex/gpt-6-luna",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/minimax-m3",
] as const satisfies readonly (typeof MODELS)[number][];

export const INSTRUCTIONS =
  "Generate a Git commit message from the supplied diff. Output exactly one short, tidy commit subject line and nothing else: no quotes, Markdown, explanation, bullet points, body, or surrounding whitespace. Use imperative mood, describe the actual change, keep it under 100 characters, start with capital letter, and do not end with a period. Use the recent commit subjects only as style context; do not copy them unless they accurately describe this diff. If there are several unrelated changes in this commit, describe them all.";

// Match the reference script: keep filenames and code, without hunk positions or hashes.
export function compactDiff(diff: string): string {
  const lines: string[] = [];
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      lines.push(line.slice("diff --git ".length));
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && /^[ +-]/.test(line)) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export function makePrompt(recentSubjects: string, diff: string): string {
  return `${INSTRUCTIONS}\n\nRecent commit subjects (style context):\n${recentSubjects.trimEnd()}\n\nSelected Git diff:\n${compactDiff(diff)}\n`;
}

export function firstSubject(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}
