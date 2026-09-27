use axum::{
    Json,
    extract::{Multipart, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::{logging::LogReason, transcription::AppState};

pub(super) const MAX_UPLOAD: usize = 25 * 1024 * 1024;

pub(super) struct ApiError(StatusCode, String, &'static str);

impl ApiError {
    pub(super) fn bad_request(reason: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, reason.into(), reason)
    }

    fn invalid_multipart(error: impl std::fmt::Display) -> Self {
        Self(
            StatusCode::BAD_REQUEST,
            error.to_string(),
            "invalid multipart request",
        )
    }

    pub(super) fn internal(reason: &'static str, error: impl std::fmt::Display) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{reason}: {error}"),
            reason,
        )
    }

    pub(super) fn model_not_found(model: &str) -> Self {
        Self(
            StatusCode::NOT_FOUND,
            format!("model not found: {model}"),
            "model not found",
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

pub(super) async fn transcribe(
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
    let text = state.transcribe(file, model, language, temperature).await?;

    if response_format == "text" {
        Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
    } else {
        Ok(Json(json!({ "text": text })).into_response())
    }
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

#[cfg(test)]
mod tests {
    use super::valid_model_name;

    #[test]
    fn model_names_are_file_stems() {
        assert!(valid_model_name("whisper-base.en"));
        assert!(valid_model_name("parakeet-tdt-0.6b-v3"));
        for name in ["", "../secret", "a/b", "a\\b", ".hidden", "a..b"] {
            assert!(!valid_model_name(name), "accepted {name}");
        }
    }
}
