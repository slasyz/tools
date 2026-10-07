import { spawn } from "node:child_process";

export class CommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface CommandOptions {
  signal?: AbortSignal;
  inherit?: boolean;
  input?: string;
}

export async function run(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      signal: options.signal,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let commandError: Error | undefined;
    child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.setEncoding("utf8").on("data", (data: string) => {
      stderr += data;
    });
    // A command may exit before consuming all of its input.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      commandError =
        error.code === "ENOENT"
          ? new CommandError(`${command} is required but was not found on PATH.`)
          : error;
    });
    child.on("close", (code, signal) => {
      if (commandError) reject(commandError);
      else if (signal) reject(new CommandError(`${command} was interrupted.`, 130));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.end(options.input);
  });
}

export async function checked(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new CommandError(
      result.stderr.trim() || `${command} exited with status ${result.code}.`,
      result.code,
    );
  }
  return result.stdout;
}
