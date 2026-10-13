import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

// Opt-in: this starts a private OpenCode server with an isolated home and
// exercises the real OS sandbox, without a model call or user configuration.
test.skipIf(process.env.OPENCODE_SANDBOX_INTEGRATION !== "1")(
  "OpenCode loads RPC and runs OS-restricted shell workers",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-sandbox-integration-")));
    const project = join(root, "project");
    const home = join(root, "home");
    const password = randomUUID();
    mkdirSync(project);
    mkdirSync(join(home, ".agents"), { recursive: true });
    const protectedPath = join(root, "protected.txt");
    writeFileSync(protectedPath, "private-fixture");
    writeFileSync(
      join(home, ".agents", "sandbox.json"),
      JSON.stringify({
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: [protectedPath],
          allowRead: [project],
          allowWrite: [project, join(home, ".local/share/opencode-sandbox/workers")],
          denyWrite: [join(project, ".env")],
        },
      }),
    );
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({
        plugins: [
          fileURLToPath(new URL("../", import.meta.url)),
          fileURLToPath(new URL("./fixtures/", import.meta.url)),
        ],
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
        ],
      }),
    );
    const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
    try {
      const baseURL = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`OpenCode did not start: ${logs}`)),
          15_000,
        );
        const onData = (chunk: Buffer) => {
          logs += chunk.toString();
          const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (url) {
            clearTimeout(timer);
            resolve(url);
          }
        };
        server.stdout.on("data", onData);
        server.stderr.on("data", onData);
        server.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        server.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`OpenCode exited: ${logs}`));
        });
      });
      async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
        const response = await fetch(`${baseURL}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json();
        expect(response.ok, JSON.stringify(result)).toBe(true);
        return result as T;
      }
      expect(
        await api("/api/rpc/opencode-sandbox/claim", {
          input: { id: "missing", clientID: "test" },
        }),
      ).toEqual({ output: false });
      const { data: session } = await api<{ data: { id: string } }>("/api/session", {
        title: "Sandbox integration fixture",
      });
      const status = await api<{ output: { enabled: boolean; configPath: string } }>(
        "/api/rpc/opencode-sandbox/status",
        {
          input: { sessionID: session.id },
        },
      );
      expect(status.output.enabled).toBe(true);
      expect(status.output.configPath).toBe(join(home, ".agents", "sandbox.json"));
      const plugins = await api<{
        data: Array<{ id: string; features: { server?: boolean; tui?: boolean } }>;
      }>("/api/plugin");
      expect(plugins.data.some((plugin) => plugin.id === "sandbox-test-driver")).toBe(true);
      const toolResult = await api<{ output: { output: { exit: number; output: string } } }>(
        "/api/rpc/sandbox-test-driver/invoke",
        {
          input: {
            sessionID: session.id,
            tool: "shell",
            args: { command: "printf native-tool-probe" },
          },
        },
      );
      expect(toolResult.output.output.exit).toBe(0);
      expect(toolResult.output.output.output).toBe("native-tool-probe");
      for (const input of [
        { tool: "read", args: { path: protectedPath } },
        { tool: "write", args: { path: ".env", content: "forbidden" } },
        {
          tool: "patch",
          args: { patchText: `*** Begin Patch\n*** Add File: .env\n+forbidden\n*** End Patch` },
        },
      ]) {
        const denied = await fetch(`${baseURL}/api/rpc/sandbox-test-driver/invoke`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
          body: JSON.stringify({ input: { sessionID: session.id, ...input } }),
          signal: AbortSignal.timeout(5000),
        });
        const failure = await denied.json();
        expect(JSON.stringify(failure)).toContain("Sandbox:");
        expect(failure).not.toHaveProperty("output");
      }
      expect(existsSync(join(project, ".env"))).toBe(false);
      async function command(command: string) {
        type ShellRecord = { id: string; status: string; shell: string; exit?: number };
        const created = await api<{ data: ShellRecord }>("/api/shell", {
          command,
          timeout: 10_000,
        });
        const info = created.data;
        let status = info;
        const deadline = Date.now() + 12_000;
        // This loop is test synchronization, not agent polling a background task.
        while (status.status === "running" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const current = await api<{ data: ShellRecord }>(`/api/shell/${info.id}`);
          status = current.data;
        }
        expect(status.status).not.toBe("running");
        const capture = await api<{ data: { output: string } }>(`/api/shell/${info.id}/output`);
        return { info: status, output: capture.data.output };
      }
      const success = await command("printf sandbox-probe");
      expect(success.info.exit).toBe(0);
      expect(success.output).toBe("sandbox-probe");
      const deniedWrite = await command("printf forbidden > .env");
      expect(deniedWrite.info.exit).not.toBe(0);
      expect(existsSync(join(project, ".env"))).toBe(false);
      const deniedRead = await command(`cat '${protectedPath}'`);
      expect(deniedRead.info.exit).not.toBe(0);
      expect(deniedRead.output).not.toContain("private-fixture");
      const deniedLauncher = await command(`rm -f '${success.info.shell}'`);
      expect(deniedLauncher.info.exit).not.toBe(0);
      expect(existsSync(success.info.shell)).toBe(true);
    } finally {
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
      await closed;
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
