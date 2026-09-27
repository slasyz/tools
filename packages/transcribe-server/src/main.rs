use std::{env, fs, io::IsTerminal, net::SocketAddr};

use axum::{Router, extract::DefaultBodyLimit, middleware, routing::post};

mod api;
mod audio;
#[cfg(target_os = "macos")]
mod launch_agent;
mod logging;
mod transcription;

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
        .fmt_fields(logging::PlainFields)
        .with_writer(std::io::stdout)
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let models_dir = transcription::models_dir()?;
    fs::create_dir_all(&models_dir)?;
    let state = transcription::AppState::new(models_dir.clone());
    let app = Router::new()
        .route("/v1/audio/transcriptions", post(api::transcribe))
        .layer(DefaultBodyLimit::max(api::MAX_UPLOAD + 1024 * 1024))
        .layer(middleware::from_fn(logging::log_request))
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
