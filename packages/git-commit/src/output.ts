import chalk from "chalk";
import wrapAnsi from "wrap-ansi";

import { INSTRUCTIONS } from "./prompt.ts";

interface Context {
  scope: string;
  files: string;
  subjects: string;
  diff: string;
}

interface InputStats {
  promptChars: number;
  diffLines: number;
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

function formatInputStats(stats: InputStats): string {
  return `${countFormat.format(stats.promptChars)} chars, ${countFormat.format(stats.diffLines)} LoC`;
}

function formatInputSuffix(stats?: InputStats): string {
  return stats ? ` ${chalk.dim(`(${formatInputStats(stats)})`)}` : "";
}

export function formatMessage(message: string, seconds?: number): string {
  const suffix = seconds === undefined ? "" : ` ${chalk.dim(`(${seconds.toFixed(2)}s)`)}`;
  return `${chalk.bold.cyan("Proposed commit message")}${suffix}\n  ${chalk.bold.green(message)}\n`;
}

export function formatGenerationStart(model: string, stats?: InputStats): string {
  return `${chalk.bold.cyan("Generating commit message with")} ${chalk.bold.white(model)}${formatInputSuffix(stats)}...`;
}

export function formatBenchmarkStart(stats: InputStats): string {
  return `${chalk.bold.cyan("Generating commit messages")}${formatInputSuffix(stats)}${chalk.bold.cyan("...")}`;
}

export function formatBenchmarkResult(model: string, message: string, seconds: number): string {
  return `${chalk.bold.cyan("Model")} ${chalk.bold.white(model)} ${chalk.dim(`(${seconds.toFixed(2)}s)`)}\n  ${chalk.bold.green(message)}\n`;
}

export function formatReviewPrompt(): string {
  return [
    `${chalk.bold("Enter")}: accept · ${chalk.bold("Type feedback + Enter")}: regenerate`,
    `${chalk.bold("Ctrl-G")}: edit · ${chalk.bold("Ctrl-C")}: stop`,
    chalk.cyan("> "),
  ].join("\n");
}
