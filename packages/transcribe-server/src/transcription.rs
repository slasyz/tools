use std::{
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::body::Bytes;
use transcribe_cpp::{ExtSlot, Model, RunExtension, RunOptions, WhisperRunOptions, sys};

use crate::{api::ApiError, audio::decode_audio};

type ModelCache = Arc<Mutex<Option<(String, Model)>>>;

#[derive(Clone)]
pub(super) struct AppState {
    models_dir: PathBuf,
    cache: ModelCache,
}

impl AppState {
    pub(super) fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) async fn transcribe(
        self,
        file: Bytes,
        model: String,
        language: Option<String>,
        temperature: Option<String>,
    ) -> Result<String, ApiError> {
        let path = self.models_dir.join(format!("{model}.gguf"));
        if !path.is_file() {
            return Err(ApiError::model_not_found(&model));
        }

        // ffmpeg and inference are blocking; keep them off the HTTP runtime threads.
        tokio::task::spawn_blocking(move || {
            let pcm = decode_audio(&file)?;
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if !cache.as_ref().is_some_and(|(name, _)| name == &model) {
                let loaded = Model::load(&path)
                    .map_err(|e| ApiError::internal("failed to load model", e))?;
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
        .map_err(|e| ApiError::internal("transcription task failed", e))?
    }
}

pub(super) fn models_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or("HOME is not set")?;
    Ok(base.join("transcribe-server/models"))
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

#[cfg(test)]
mod tests {
    use super::parse_temperature;

    #[test]
    fn temperature_must_be_finite_and_in_range() {
        assert_eq!(parse_temperature("0").ok(), Some(0.0));
        assert_eq!(parse_temperature("0.7").ok(), Some(0.7));
        assert_eq!(parse_temperature("1").ok(), Some(1.0));
        for value in ["", "NaN", "inf", "-0.1", "1.1", "not-a-number"] {
            assert!(parse_temperature(value).is_err(), "accepted {value}");
        }
    }
}
