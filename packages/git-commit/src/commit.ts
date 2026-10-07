import { join } from "node:path";

import { readFile, rm, writeFile } from "node:fs/promises";

import { askForAction, type Action } from "./input.ts";
import { checked, CommandError, run } from "./process.ts";
import { firstSubject, makePrompt, MODELS } from "./prompt.ts";

interface Options {
  signal?: AbortSignal;
  ask?: (signal?: AbortSignal) => Promise<Action>;
}

export async function main(
  args: string[],
  { signal, ask = askForAction }: Options = {},
): Promise<number> {
  let tempDir: string | undefined;
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log("Usage: git-commit2 [-s]\n  -s  Select a model with fzf");
      return 0;
    }
    if (args.length > 1 || (args.length === 1 && args[0] !== "-s")) {
      throw new CommandError("Usage: git-commit2 [-s]", 2);
    }

    let model: string = MODELS[0];
    if (args[0] === "-s") {
      const result = await run(
        "fzf",
        ["--height=14", "--border", "--no-sort", "--layout=reverse", "--prompt=Model: "],
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
      console.log(`git-commit2: no ${scope} to commit.`);
      return 0;
    }

    if (ask === askForAction && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new CommandError("an interactive terminal is required to review the message.");
    }

    console.log(`Files with ${scope}:\n${await git(["diff", ...diffArgs, "--name-status"])}`);
    const head = await run("git", ["rev-parse", "--verify", "HEAD"], { signal });
    const subjects = head.code === 0 ? await git(["log", "-n", "5", "--format=%s"]) : "";
    const prompt = makePrompt(subjects, await git(["diff", "--unified=1", ...diffArgs]));
    console.log(`Prompt:\n${prompt}`);

    tempDir = (
      await checked("mktemp", ["-d", "-p", "/tmp", "git-commit2.XXXXXX"], { signal })
    ).trim();
    const requestFile = join(tempDir, "request.txt");
    const sessionFile = join(tempDir, "session.jsonl");
    const messageFile = join(tempDir, "message.txt");
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    let message = "";
    let generatedSubject = "";
    let generationSeconds = 0;

    async function generate(userMessage: string) {
      await writeFile(requestFile, userMessage, { mode: 0o600 });
      console.log(`\nGenerating commit message with ${model}...\n`);
      const started = Date.now();
      // Reopen only this temporary session so feedback follows prior user/assistant turns.
      const result = await run(
        "pi",
        [
          "--print",
          "--session",
          sessionFile,
          "--session-dir",
          tempDir!,
          "--no-tools",
          "--model",
          model,
          "--thinking",
          "minimal",
          `@${requestFile}`,
        ],
        { signal },
      );
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.code !== 0) throw new CommandError("pi could not generate a commit message.");
      message = firstSubject(result.stdout);
      if (!message) throw new CommandError("pi returned an empty commit message.");
      generatedSubject = message;
      generationSeconds = Math.floor((Date.now() - started) / 1000);
    }

    await generate(prompt);
    while (true) {
      console.log(
        `Proposed commit message (generated in ${generationSeconds} second(s)):\n  ${message}\n`,
      );
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
        await generate(feedback);
        continue;
      }

      await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
      // The editor command is trusted user configuration; pass the filename separately.
      const edited = await run(
        "/bin/sh",
        ["-c", `exec ${editor} "$1"`, "git-commit2-editor", messageFile],
        { signal, inherit: true },
      );
      if (edited.code !== 0) {
        console.error("git-commit2: editor failed; keeping the proposed message.");
        continue;
      }
      const editedMessage = firstSubject(await readFile(messageFile, "utf8"));
      if (!editedMessage)
        console.error(
          "git-commit2: editor produced an empty message; keeping the proposed message.",
        );
      else message = editedMessage;
    }
  } catch (error) {
    if (signal?.aborted) {
      console.error("\ngit-commit2: stopped.");
      return 130;
    }
    console.error(`git-commit2: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CommandError ? error.exitCode : 1;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
