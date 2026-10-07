# transcribe-server

Local OpenAI-style audio transcription server. Listens on
`127.0.0.1:17863` without authentication.

## Build

Run the commands below from `packages/transcribe-server`.

Building requires CMake and a C++ toolchain (such as Apple's Command Line
Tools); running requires `ffmpeg`. On macOS:

```sh
brew install cmake ffmpeg
```

```sh
cargo install --path .
```

To run without installing, use `cargo run`.

## Use

Place GGUF models in `~/.local/share/transcribe-server/models/`.
Use the file name without `.gguf` as the `model` value
(for example, `whisper-base.en` or `gigaam-v3-e2e-rnnt-Q4_K_M.gguf`).

Run `transcribe-server` (stop the service first if it is running). Example request:

```sh
curl http://127.0.0.1:17863/v1/audio/transcriptions \
  -F 'model=whisper-base.en' \
  -F 'file=@recording.mp3'
```

Returns `{"text":"..."}`. `file` and `model` are required; `language`,
`response_format` (`json` or `text`), and `temperature` (0–1 for Whisper) are
optional. Uploads are limited to 25 MiB and audio to 10 minutes. The server
keeps the most recently used model in RAM and transcribes one request at a
time; RAM use depends on model size.

## Install as a macOS service

```sh
transcribe-server install
```

This starts the server now and at future logins (not before login), and restarts
it if it exits. Logs are in `~/Library/Logs/transcribe-server/`.

```sh
transcribe-server stop
transcribe-server start
transcribe-server restart
```

`stop` only stops it for the current login; `restart` also starts it if stopped.

```sh
transcribe-server uninstall
```

`uninstall` leaves the binary, models, and logs in place. To remove the binary,
run `cargo uninstall transcribe-server`. To upgrade, uninstall the LaunchAgent
before reinstalling the binary, then run `transcribe-server install` again.
