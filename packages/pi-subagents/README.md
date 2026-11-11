# pi-subagents

Background Pi agents with six tools and a live status widget above the editor.
Requires Pi 1.5.0+ and Node.js 22.19+.

Run commands from this directory:

```sh
pi -e ./index.ts
# Or install for future sessions:
pi install "$(pwd)"
```

## Tools

| Tool              | Arguments                                                               | Behavior                                                                                  |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `spawn_agent`     | `task_name`, `message`, optional `model`, `fork_turns: "all" \| "none"` | Start a background agent; return its ID after startup.                                    |
| `send_message`    | `target`, `message`                                                     | Steer after the current turn, or resume an idle agent.                                    |
| `followup_task`   | `target`, `message`                                                     | Queue work after the current task, or resume an idle agent.                               |
| `list_agents`     | none                                                                    | Show this parent's agents, statuses, and latest results.                                  |
| `wait_agent`      | optional `timeout_ms`                                                   | Return an uncollected result, or wait up to 30 seconds by default (maximum five minutes). |
| `interrupt_agent` | `target`                                                                | Clear queued work and stop the agent without discarding its context.                      |

Use the exact returned ID as `target`. Names are labels, not addresses.
`wait_agent` keeps the latest uncollected completion per agent. Automatic completion
messages also reach the parent conversation and wake it if idle.
While the parent is working, results arrive after its current turn and tools.

`spawn_agent` defaults to the parent's current model. Set `model` to an exact
`provider/model-id` from `pi --list-models` to override it for that agent without
changing the parent's model. Unknown IDs are rejected; partial names are not accepted.
The override also applies with `fork_turns: "all"`.

## Behavior and limits

- Each agent runs a long-lived local `pi --mode rpc` subprocess, not tmux.
- New agents inherit the parent's current model (unless `model` is set), reasoning level, working directory,
  active tool names, project trust decision, and CLI resource options. They also
  discover normal Pi settings and extensions. Parent-only runtime changes to
  providers, tools, credentials, or extension state cannot cross the process boundary.
  Pi clamps the inherited reasoning level to the selected model's capabilities.
- Fresh context is the default. `fork_turns: "all"` copies the active session branch,
  including compaction records, before the spawning tool-call turn. It does not copy
  unfinished tool calls or abandoned branches.
- Four agents may work concurrently; up to 32 agents can exist per parent session.
  Idle subprocesses stay available for follow-ups. Nested spawning is disabled.
- Agents share files and permissions, not isolated worktrees. Avoid overlapping
  edits. Interruption does not undo changes.
- The widget shows **starting**, **running**, **idle**, **interrupted**, or **failed**.
  Completion and failure messages appear in the conversation. A model failure can
  be resumed; an exited process requires a new agent.
- Child confirmations, selections, and text inputs are serialized through the parent
  UI. Without a UI they are cancelled. Editor and TUI-only custom dialogs are not
  supported; no permission is granted automatically.
- Result previews are limited to 12 KB/200 lines (800 bytes/10 lines in lists).
  `output_file` contains the full final assistant text; `session_file` contains the
  full transcript. Both live in a private `/tmp/pi-subagents-*` directory.
- Parent exit, `/reload`, session switch, and fork stop all children and remove
  their temporary files. Agents do not survive a parent restart. A failed command
  delivery stops that child rather than leaving uncertain background work running.

## Development

Install workspace dependencies from the repository root with `pnpm install`.
Then, from this directory:

```sh
pnpm check
pnpm test
```

Tests use Node's test runner, fake RPC peers, and fake agent connections; no model
API requests are needed.
