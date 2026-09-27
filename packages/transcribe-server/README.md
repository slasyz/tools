# transcribe-server

Local OpenAI-style audio transcription server. Building requires CMake and a C++
toolchain. Running the compiled binary requires `ffmpeg`.

On macOS, install CMake and ffmpeg with Homebrew:

```sh
brew install cmake ffmpeg
```

A C++ toolchain is also required (for example, Apple's Command Line Tools).

Place GGUF models in `~/.local/share/transcribe-server/models/`, or in
`$XDG_DATA_HOME/transcribe-server/models/` when `XDG_DATA_HOME` is set. The
directory is created at startup. The `model` form field is the file name without
`.gguf`, for example `whisper-base.en` selects `whisper-base.en.gguf`.

```sh
cargo run

curl http://127.0.0.1:17863/v1/audio/transcriptions \
  -F 'model=whisper-base.en' \
  -F 'file=@recording.mp3'
```

`transcribe-cpp` logs are silenced by default. Run `cargo run -- --verbose` to
show its native logs on stderr. The server's request logs remain enabled.

Returns `{"text":"..."}` by default. Multipart fields `file` and `model` are
required; `language`, `response_format` (`json` or `text`), and `temperature`
are optional. `temperature` must be between 0 and 1 for Whisper models; other
models ignore it. Other OpenAI transcription options are not supported. Audio
can be in any format your `ffmpeg` installation decodes. Uploads are limited
to 25 MiB and decoded audio to 10 minutes. The server listens only on
`127.0.0.1:17863`, without auth.
It keeps the most recently used model in memory and processes inference one
request at a time.
Each request is logged to standard output with a timestamp, level, method,
path, response status, and elapsed time. Errors include a short reason. Audio,
transcripts, query strings, and raw error details are not logged.
Log colors are enabled only when stdout is a terminal; redirected logs, such as
those from a LaunchAgent, remain plain text.

## Start automatically at macOS login

From `packages/transcribe-server`, install a release binary with Cargo, then
register it as a per-user LaunchAgent (no root access needed):

```sh
cargo install --path .
transcribe-server install
```

Run these commands while logged in to the Mac desktop, with Cargo's binary
directory on your `PATH`. The server starts now and at future logins, and
restarts if it exits. This does not start before login. The command creates
`~/Library/LaunchAgents/local.transcribe-server.plist` and logs to
`~/Library/Logs/transcribe-server/{stdout,stderr}.log`. It uses the standard
Homebrew paths for `ffmpeg` (`/opt/homebrew/bin` and `/usr/local/bin`). Place
models in `~/.local/share/transcribe-server/models/` before making
transcription requests; a shell-only `XDG_DATA_HOME` setting is not passed to
the LaunchAgent.

Manage the installed LaunchAgent without changing its login setup:

```sh
transcribe-server stop
transcribe-server start
transcribe-server restart
```

`stop` stops it for the current login; it starts again at the next login.
`restart` also starts it if it was stopped. These commands require a prior
`transcribe-server install`.

To stop automatic startup and remove the LaunchAgent (logs, models, and binary
are left intact):

```sh
transcribe-server uninstall
```

To remove the binary as well, run
`cargo uninstall transcribe-server` after uninstalling the agent. For upgrades,
uninstall the agent before replacing the binary, then repeat the install
commands above.
