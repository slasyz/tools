use std::time::Instant;

use axum::{extract::Request, middleware::Next, response::Response};
use tracing_subscriber::{
    field::RecordFields,
    fmt::format::{DefaultFields, FormatFields, Writer},
};

#[derive(Clone, Copy)]
pub(super) struct LogReason(pub(super) &'static str);

pub(super) struct PlainFields;

impl<'writer> FormatFields<'writer> for PlainFields {
    fn format_fields<R: RecordFields>(
        &self,
        mut writer: Writer<'writer>,
        fields: R,
    ) -> std::fmt::Result {
        DefaultFields::new().format_fields(Writer::new(&mut writer), fields)
    }
}

pub(super) async fn log_request(request: Request, next: Next) -> Response {
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

#[cfg(test)]
mod tests {
    use super::PlainFields;
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
}
