import { join } from "node:path";

import chalk from "chalk";
import { readFile, rm, writeFile } from "node:fs/promises";

import { askForAction, type Action } from "./input.ts";
import {
  formatBenchmarkResult,
  formatBenchmarkStart,
  formatContext,
  formatGenerationStart,
  formatMessage,
  formatModel,
} from "./output.ts";
import { checked, CommandError, run } from "./process.ts";
import { parseGeneration } from "./pi.ts";
import {
  BENCHMARK_MODELS,
  firstSubject,
  INSTRUCTIONS,
  makePrompt,
  MODELS,
  THINKING_LEVEL,
} from "./prompt.ts";

interface Options {
  signal?: AbortSignal;
  ask?: (signal?: AbortSignal) => Promise<Action>;
}

async function generateSubject(
  model: string,
  requestFile: string,
  sessionFile: string,
  tempDir: string,
  signal?: AbortSignal,
): Promise<{ subject: string; cost?: number }> {
  const result = await run(
    "pi",
    [
      "--print",
      "--mode",
      "json",
      "--session",
      sessionFile,
      "--session-dir",
      tempDir,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--system-prompt",
      INSTRUCTIONS,
      "--model",
      model,
      "--thinking",
      THINKING_LEVEL,
      `@${requestFile}`,
    ],
    { signal },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) throw new CommandError("pi could not generate a commit message.");
  return parseGeneration(result.stdout);
}

export async function main(
  args: string[],
  { signal, ask = askForAction }: Options = {},
): Promise<number> {
  let tempDir: string | undefined;
  try {
    const usage = "Usage: git-commit [-s | -b]";
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log(
        `${usage}\n  -s  Select a listed or custom model with fzf\n  -b  Benchmark models in parallel, then select a message to review and commit`,
      );
      return 0;
    }
    if (args.length > 1 || (args.length === 1 && args[0] !== "-s" && args[0] !== "-b")) {
      throw new CommandError(usage, 2);
    }
    const benchmark = args[0] === "-b";

    let model: string = MODELS[0];
    if (args[0] === "-s") {
      const result = await run(
        "fzf",
        [
          "--height=14",
          "--border",
          "--no-sort",
          "--layout=reverse",
          "--prompt=Model: ",
          "--bind=enter:accept-or-print-query",
          "--header=Enter: select match or use typed name when nothing matches · Esc: cancel",
        ],
        {
          signal,
          input: `${MODELS.join("\n")}\n`,
        },
      );
      if (result.code !== 0 || !result.stdout.trim())
        throw new CommandError("model selection cancelled.", 130);
      model = result.stdout.trim();
    }

    const git = (gitArgs: string[]) => checked("git", ["--no-pager", ...gitArgs], { signal });
    const workTree = await run("git", ["rev-parse", "--is-inside-work-tree"], { signal });
    if (workTree.code !== 0 || workTree.stdout.trim() !== "true") {
      throw new CommandError("not inside a Git work tree.");
    }

    const staged = await run("git", ["diff", "--cached", "--quiet"], { signal });
    if (staged.code > 1)
      throw new CommandError(staged.stderr.trim() || "could not inspect staged changes.");
    const diffArgs = staged.code === 1 ? ["--cached"] : [];
    const commitArgs = staged.code === 1 ? [] : ["-a"];
    const scope = staged.code === 1 ? "staged changes" : "tracked unstaged changes";
    const changes = await run("git", ["diff", ...diffArgs, "--quiet"], { signal });
    if (changes.code > 1)
      throw new CommandError(changes.stderr.trim() || "could not inspect changes.");
    if (changes.code === 0) {
      console.log(`git-commit: no ${scope} to commit.`);
      return 0;
    }

    const interactive = ask !== askForAction || !!(process.stdin.isTTY && process.stdout.isTTY);
    if (!benchmark && !interactive) {
      throw new CommandError("an interactive terminal is required to review the message.");
    }

    const head = await run("git", ["rev-parse", "--verify", "HEAD"], { signal });
    const subjects =
      head.code === 0 ? await git(["log", "--color=never", "-n", "5", "--format=%s"]) : "";
    const diff = await git(["diff", "--color=never", "--unified=1", ...diffArgs]);
    const prompt = makePrompt(subjects, diff);
    const inputStats = {
      promptChars: Array.from(prompt).length,
      diffLines: diff ? diff.replace(/\r?\n$/, "").split(/\r?\n/).length : 0,
    };
    const files = await git(["diff", "--color=never", ...diffArgs, "--name-status"]);
    const displayDiff =
      chalk.level > 0 ? await git(["diff", "--color=always", "--unified=1", ...diffArgs]) : diff;
    console.log(`\n${formatContext({ scope, files, subjects, diff: displayDiff })}`);

    tempDir = (
      await checked("mktemp", ["-d", "-p", "/tmp", "git-commit.XXXXXX"], { signal })
    ).trim();
    const requestFile = join(tempDir, "request.txt");
    let sessionFile = join(tempDir, "session.jsonl");
    let message = "";
    let generatedSubject = "";
    let stats: { seconds: number; cost?: number } | undefined;
    if (benchmark) {
      await writeFile(requestFile, prompt, { mode: 0o600 });
      console.log(`\n${formatBenchmarkStart(inputStats)}\n`);
      // Wait for every call, including failures, before removing the shared request file.
      const results = await Promise.all(
        BENCHMARK_MODELS.map(async (benchmarkModel, index) => {
          const started = performance.now();
          const benchmarkSession = join(tempDir!, `session-${index}.jsonl`);
          try {
            const { subject, cost } = await generateSubject(
              benchmarkModel,
              requestFile,
              benchmarkSession,
              tempDir!,
              signal,
            );
            const seconds = (performance.now() - started) / 1000;
            console.log(formatBenchmarkResult(benchmarkModel, subject, seconds, cost));
            return { model: benchmarkModel, sessionFile: benchmarkSession, subject, seconds, cost };
          } catch (error) {
            const seconds = (performance.now() - started) / 1000;
            console.error(
              `${chalk.bold.cyan("Model")} ${formatModel(benchmarkModel)} ${chalk.dim(`(${seconds.toFixed(2)}s)`)}\n  ${chalk.red(error instanceof Error ? error.message : String(error))}\n`,
            );
            return undefined;
          }
        }),
      );
      signal?.throwIfAborted();
      const candidates = results.filter((result) => result !== undefined);
      if (!interactive || candidates.length === 0) {
        return candidates.length !== results.length ? 1 : 0;
      }
      const choices = candidates.map((candidate) => `${candidate.subject}  (${candidate.model})`);
      console.log(chalk.bold.cyan("Choose a message to review and commit."));
      const selection = await run(
        "fzf",
        [
          "--height=14",
          "--border",
          "--no-sort",
          "--layout=reverse",
          "--prompt=Message: ",
          "--header=Enter: review selected message · Esc: cancel",
        ],
        { signal, input: `${choices.join("\n")}\n` },
      );
      const selected = candidates[choices.indexOf(selection.stdout.trim())];
      if (selection.code !== 0 || !selected) {
        throw new CommandError("message selection cancelled.", 130);
      }
      model = selected.model;
      sessionFile = selected.sessionFile;
      message = selected.subject;
      generatedSubject = message;
      stats = { seconds: selected.seconds, cost: selected.cost };
    }
    const messageFile = join(tempDir, "message.txt");
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";

    async function generate(userMessage: string, showInputStats = false) {
      await writeFile(requestFile, userMessage, { mode: 0o600 });
      console.log(`\n${formatGenerationStart(model, showInputStats ? inputStats : undefined)}\n`);
      const started = performance.now();
      // Reopen only this temporary session so feedback follows prior user/assistant turns.
      const result = await generateSubject(model, requestFile, sessionFile, tempDir!, signal);
      message = result.subject;
      generatedSubject = message;
      return { seconds: (performance.now() - started) / 1000, cost: result.cost };
    }

    if (!benchmark) stats = await generate(prompt, true);
    while (true) {
      console.log(formatMessage(message, stats?.seconds, stats?.cost));
      stats = undefined;
      const action = await ask(signal);
      if (action.type === "accept") {
        return (
          await run("git", ["commit", ...commitArgs, "-m", message], { signal, inherit: true })
        ).code;
      }
      if (action.type === "feedback") {
        const feedback =
          message === generatedSubject
            ? action.text
            : `Current commit subject after editing:\n${message}\n\n${action.text}`;
        stats = await generate(feedback);
        continue;
      }

      await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
      // The editor command is trusted user configuration; pass the filename separately.
      const edited = await run(
        "/bin/sh",
        ["-c", `exec ${editor} "$1"`, "git-commit-editor", messageFile],
        { signal, inherit: true },
      );
      if (edited.code !== 0) {
        console.error("git-commit: editor failed; keeping the proposed message.");
        continue;
      }
      const editedMessage = firstSubject(await readFile(messageFile, "utf8"));
      if (!editedMessage)
        console.error(
          "git-commit: editor produced an empty message; keeping the proposed message.",
        );
      else message = editedMessage;
    }
  } catch (error) {
    if (signal?.aborted) {
      console.error("\ngit-commit: stopped.");
      return 130;
    }
    console.error(`git-commit: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CommandError ? error.exitCode : 1;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
