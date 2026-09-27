use std::{
    env, fs,
    io::{IsTerminal, Read, Write},
    net::SocketAddr,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use tracing_subscriber::{
    field::RecordFields,
    fmt::format::{DefaultFields, FormatFields, Writer},
};
use transcribe_cpp::{ExtSlot, Model, RunExtension, RunOptions, WhisperRunOptions, sys};

#[cfg(target_os = "macos")]
mod launch_agent;

const MAX_UPLOAD: usize = 25 * 1024 * 1024;
const MAX_PCM_BYTES: u64 = 10 * 60 * 16_000 * 4; // 10 minutes of 16 kHz mono f32

type ModelCache = Arc<Mutex<Option<(String, Model)>>>;

#[derive(Clone)]
struct AppState {
    models_dir: PathBuf,
    cache: ModelCache,
}

struct ApiError(StatusCode, String, &'static str);

#[derive(Clone, Copy)]
struct LogReason(&'static str);

struct PlainFields;

impl<'writer> FormatFields<'writer> for PlainFields {
    fn format_fields<R: RecordFields>(
        &self,
        mut writer: Writer<'writer>,
        fields: R,
    ) -> std::fmt::Result {
        DefaultFields::new().format_fields(Writer::new(&mut writer), fields)
    }
}

impl ApiError {
    fn bad_request(reason: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, reason.into(), reason)
    }

    fn invalid_multipart(error: impl std::fmt::Display) -> Self {
        Self(
            StatusCode::BAD_REQUEST,
            error.to_string(),
            "invalid multipart request",
        )
    }

    fn internal(reason: &'static str, error: impl std::fmt::Display) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{reason}: {error}"),
            reason,
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let kind = if self.0.is_client_error() {
            "invalid_request_error"
        } else {
            "server_error"
        };
        let mut response = (
            self.0,
            Json(json!({ "error": { "message": self.1, "type": kind } })),
        )
            .into_response();
        response.extensions_mut().insert(LogReason(self.2));
        response
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    match args.as_slice() {
        [command] if command == "install" => return launch_agent::install(),
        [command] if command == "uninstall" => return launch_agent::uninstall(),
        [command] if command == "start" => return launch_agent::start(),
        [command] if command == "stop" => return launch_agent::stop(),
        [command] if command == "restart" => return launch_agent::restart(),
        _ => {}
    }
    let verbose = match args.as_slice() {
        [] => false,
        [flag] if flag == "--verbose" => true,
        [flag] if flag == "--help" || flag == "-h" => {
            println!("{}", usage());
            return Ok(());
        }
        _ => return Err(usage().into()),
    };
    if !verbose {
        transcribe_cpp::disable_logging();
    }
    tracing_subscriber::fmt()
        .with_target(false)
        .fmt_fields(PlainFields)
        .with_writer(std::io::stdout)
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let models_dir = models_dir()?;
    fs::create_dir_all(&models_dir)?;
    let state = AppState {
        models_dir: models_dir.clone(),
        cache: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/v1/audio/transcriptions", post(transcribe))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD + 1024 * 1024))
        .layer(middleware::from_fn(log_request))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 17863));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, models_dir = %models_dir.display(), "server listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn usage() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Usage: transcribe-server [--verbose|install|uninstall|start|stop|restart]"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Usage: transcribe-server [--verbose] (service commands require macOS)"
    }
}

async fn log_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let start = Instant::now();
    let response = next.run(request).await;
    let status = response.status();
    let elapsed_ms = start.elapsed().as_millis();
    let reason = response
        .extensions()
        .get::<LogReason>()
        .map(|reason| reason.0)
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("unknown error"));
    if status.is_server_error() {
        tracing::error!(%method, %path, %status, elapsed_ms, reason, "http request");
    } else if status.is_client_error() {
        tracing::warn!(%method, %path, %status, elapsed_ms, reason, "http request");
    } else {
        tracing::info!(%method, %path, %status, elapsed_ms, "http request");
    }
    response
}

fn models_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or("HOME is not set")?;
    Ok(base.join("transcribe-server/models"))
}

async fn transcribe(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let mut model = None;
    let mut file = None;
    let mut language = None;
    let mut temperature = None;
    let mut response_format = "json".to_owned();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(ApiError::invalid_multipart)?
    {
        match field.name() {
            Some("model") => {
                if model.is_some() {
                    return Err(ApiError::bad_request("duplicate model field"));
                }
                model = Some(field.text().await.map_err(ApiError::invalid_multipart)?);
            }
            Some("file") => {
                if file.is_some() {
                    return Err(ApiError::bad_request("duplicate file field"));
                }
                let bytes = field.bytes().await.map_err(ApiError::invalid_multipart)?;
                if bytes.is_empty() || bytes.len() > MAX_UPLOAD {
                    return Err(ApiError::bad_request("file must be 1 byte to 25 MiB"));
                }
                file = Some(bytes);
            }
            Some("language") => {
                language = Some(field.text().await.map_err(ApiError::invalid_multipart)?);
            }
            Some("temperature") => {
                temperature = Some(field.text().await.map_err(ApiError::invalid_multipart)?);
            }
            Some("response_format") => {
                response_format = field.text().await.map_err(ApiError::invalid_multipart)?;
            }
            _ => {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "unsupported form field: {}",
                        field.name().unwrap_or("<unnamed>")
                    ),
                    "unsupported form field",
                ));
            }
        }
    }

    let model = model.ok_or_else(|| ApiError::bad_request("missing model field"))?;
    if !valid_model_name(&model) {
        return Err(ApiError::bad_request("invalid model name"));
    }
    if response_format != "json" && response_format != "text" {
        return Err(ApiError::bad_request(
            "only json and text response formats are supported",
        ));
    }
    let file = file.ok_or_else(|| ApiError::bad_request("missing file field"))?;
    let path = state.models_dir.join(format!("{model}.gguf"));
    if !path.is_file() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("model not found: {model}"),
            "model not found",
        ));
    }

    // ffmpeg and inference are blocking; keep them off the HTTP runtime threads.
    let text = tokio::task::spawn_blocking(move || {
        let pcm = decode_audio(&file)?;
        let mut cache = state.cache.lock().unwrap_or_else(|e| e.into_inner());
        if !cache.as_ref().is_some_and(|(name, _)| name == &model) {
            let loaded =
                Model::load(&path).map_err(|e| ApiError::internal("failed to load model", e))?;
            *cache = Some((model, loaded));
        }
        let loaded = &cache.as_ref().expect("model was loaded").1;
        let mut session = loaded
            .session()
            .map_err(|e| ApiError::internal("failed to open session", e))?;
        let family = temperature
            .as_deref()
            .filter(|_| loaded.accepts_ext(ExtSlot::Run, sys::TRANSCRIBE_EXT_KIND_WHISPER_RUN))
            .map(parse_temperature)
            .transpose()?
            .map(|temperature| {
                RunExtension::Whisper(WhisperRunOptions {
                    temperature: Some(temperature),
                    ..WhisperRunOptions::default()
                })
            });
        let options = RunOptions {
            language,
            family,
            ..RunOptions::default()
        };
        session
            .run(&pcm, &options)
            .map(|result| result.text)
            .map_err(|e| ApiError::internal("transcription failed", e))
    })
    .await
    .map_err(|e| ApiError::internal("transcription task failed", e))??;

    if response_format == "text" {
        Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
    } else {
        Ok(Json(json!({ "text": text })).into_response())
    }
}

fn parse_temperature(value: &str) -> Result<f32, ApiError> {
    let temperature = value
        .parse::<f32>()
        .map_err(|_| ApiError::bad_request("temperature must be between 0 and 1"))?;
    if !temperature.is_finite() || !(0.0..=1.0).contains(&temperature) {
        return Err(ApiError::bad_request("temperature must be between 0 and 1"));
    }
    Ok(temperature)
}

fn valid_model_name(name: &str) -> bool {
    name.len() <= 128
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        && !name.contains("..")
}

fn decode_audio(input: &[u8]) -> Result<Vec<f32>, ApiError> {
    let mut audio_file = tempfile::Builder::new()
        .prefix("transcribe-server-")
        .tempfile_in("/tmp")
        .map_err(|e| ApiError::internal("cannot create temporary file", e))?;
    audio_file
        .write_all(input)
        .map_err(|e| ApiError::internal("cannot write audio", e))?;

    let mut child = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(audio_file.path())
        .args([
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ApiError::internal("cannot start ffmpeg", e))?;

    let mut pcm_bytes = Vec::new();
    let read_result = child
        .stdout
        .take()
        .expect("ffmpeg stdout was piped")
        .take(MAX_PCM_BYTES + 1)
        .read_to_end(&mut pcm_bytes);
    if read_result.is_err() || pcm_bytes.len() as u64 > MAX_PCM_BYTES {
        let _ = child.kill();
        let _ = child.wait();
        read_result.map_err(|e| ApiError::internal("cannot decode audio", e))?;
        return Err(ApiError::bad_request("decoded audio exceeds 10 minutes"));
    }
    let status = child
        .wait()
        .map_err(|e| ApiError::internal("ffmpeg failed", e))?;
    if !status.success() || pcm_bytes.is_empty() || pcm_bytes.len() % 4 != 0 {
        return Err(ApiError::bad_request("invalid or unsupported audio file"));
    }
    Ok(pcm_bytes
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four bytes per sample")))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{PlainFields, parse_temperature, valid_model_name};
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };

    struct LogWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for LogWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(data)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn colored_logs_do_not_italicize_field_names() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&output);
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(true)
            .with_target(false)
            .fmt_fields(PlainFields)
            .with_writer(move || LogWriter(Arc::clone(&writer)))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(field_name = 123, "test message");
        });

        let log = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert!(log.contains("\u{1b}[32m INFO\u{1b}[0m"), "{log:?}");
        assert!(log.contains("test message field_name=123"), "{log:?}");
        assert!(!log.contains("\u{1b}[3m"), "{log:?}");
    }

    #[test]
    fn temperature_must_be_finite_and_in_range() {
        assert_eq!(parse_temperature("0").ok(), Some(0.0));
        assert_eq!(parse_temperature("0.7").ok(), Some(0.7));
        assert_eq!(parse_temperature("1").ok(), Some(1.0));
        for value in ["", "NaN", "inf", "-0.1", "1.1", "not-a-number"] {
            assert!(parse_temperature(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn model_names_are_file_stems() {
        assert!(valid_model_name("whisper-base.en"));
        assert!(valid_model_name("parakeet-tdt-0.6b-v3"));
        for name in ["", "../secret", "a/b", "a\\b", ".hidden", "a..b"] {
            assert!(!valid_model_name(name), "accepted {name}");
        }
    }
}
