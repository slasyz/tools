import chalk from "chalk";
import wrapAnsi from "wrap-ansi";

import { INSTRUCTIONS } from "./prompt.ts";

interface Context {
  scope: string;
  files: string;
  subjects: string;
  diff: string;
}

interface MessageStats {
  promptChars: number;
  diffLines: number;
  seconds: number;
}

const countFormat = new Intl.NumberFormat("en-US");

function section(title: string, body: string): string {
  return `${chalk.bold.cyan(title)}\n${body.trimEnd()}`;
}

export function formatContext(
  { scope, files, subjects, diff }: Context,
  columns = process.stdout.columns ?? 80,
): string {
  const commits = subjects
    .split(/\r?\n/)
    .filter((subject) => subject.length > 0)
    .map((subject) => `  • ${subject}`)
    .join("\n");

  return [
    section(`Files with ${scope}`, files),
    section("Prompt", chalk.gray(wrapAnsi(INSTRUCTIONS, Math.max(20, Math.min(columns, 100))))),
    section("Recent commits (style context)", chalk.gray(commits || "  No recent commits.")),
    section("Git diff", diff),
  ].join("\n\n");
}

export function formatMessage(message: string, stats?: MessageStats): string {
  const suffix = stats
    ? ` ${chalk.dim(`(${countFormat.format(stats.promptChars)} chars, ${countFormat.format(stats.diffLines)} LoC, ${stats.seconds.toFixed(2)}s)`)}`
    : "";
  return `${chalk.bold.cyan("Proposed commit message")}${suffix}\n  ${chalk.bold.green(message)}\n`;
}

export function formatReviewPrompt(): string {
  return [
    `${chalk.bold("Enter")}: accept · ${chalk.bold("Type feedback + Enter")}: regenerate`,
    `${chalk.bold("Ctrl-G")}: edit · ${chalk.bold("Ctrl-C")}: stop`,
    chalk.cyan("> "),
  ].join("\n");
}
