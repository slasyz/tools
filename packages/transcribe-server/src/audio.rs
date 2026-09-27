use std::{
    io::{Read, Write},
    process::{Command, Stdio},
};

use crate::api::ApiError;

const MAX_PCM_BYTES: u64 = 10 * 60 * 16_000 * 4; // 10 minutes of 16 kHz mono f32

pub(super) fn decode_audio(input: &[u8]) -> Result<Vec<f32>, ApiError> {
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
