//! Streams a found track to a staging file, giving up on a mirror that
//! stalls or crawls while another could do better.

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::sources::{describe, Media};
use super::Live;

/// No bytes for this long once data flows: the mirror has stalled.
const STALL: Duration = Duration::from_secs(20);
/// Relays often fetch the file from the service before passing on more than
/// a first trickle; data counts as flowing from this many bytes.
const FLOWING: u64 = 256 * 1024;
/// Waiting this long for headers is as bad as a stall. Some mirrors fetch
/// the whole file from the service before sending the first byte.
const FIRST_BYTE: Duration = Duration::from_secs(40);
/// How long a download gets before its speed is judged.
const WARMUP: Duration = Duration::from_secs(12);
/// Below this, with another source left to try, a download is dropped…
const MIN_KBPS: f64 = 200.0;
/// …unless it would be done within this anyway.
const PATIENCE: Duration = Duration::from_secs(90);
/// Nothing a single track needs takes longer.
const CAP: Duration = Duration::from_secs(15 * 60);

#[derive(Debug)]
pub enum FetchError {
    /// The mirror is up but will not serve this track (region, rights).
    NotOffered(String),
    Unavailable(String),
    /// Seconds the mirror asked to be left alone.
    RateLimited(u64),
    Slow {
        kbps: f64,
    },
    Cancelled,
}

pub struct Fetched {
    pub bytes: u64,
    pub secs: f64,
}

/// Downloads `media` into `dest`. `alternatives` says whether giving up on a
/// slow mirror has a point.
pub async fn fetch(
    http: &reqwest::Client,
    media: &Media,
    dest: &Path,
    live: &Live,
    cancel: &CancellationToken,
    alternatives: bool,
) -> Result<Fetched, FetchError> {
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| FetchError::Unavailable(e.to_string()))?;
    let started = Instant::now();
    let mut meter = Meter { started, received: 0, total: None, alternatives, flowing: None };
    live.progress(0, None);
    let Media::Url { url, headers } = media else {
        return Err(FetchError::Unavailable("was never asked for the file".to_owned()));
    };
    let mut request = http.get(url);
    for (k, v) in headers {
        request = request.header(k, v);
    }
    stream(request, &mut file, &mut meter, live, cancel).await?;
    file.flush().await.map_err(|e| FetchError::Unavailable(e.to_string()))?;
    if meter.received == 0 {
        return Err(FetchError::Unavailable("sent an empty file".to_owned()));
    }
    if let Some(total) = meter.total.filter(|&t| t != meter.received) {
        return Err(FetchError::Unavailable(format!("sent {} of {total} bytes", meter.received)));
    }
    Ok(Fetched { bytes: meter.received, secs: started.elapsed().as_secs_f64() })
}

struct Meter {
    started: Instant,
    received: u64,
    total: Option<u64>,
    alternatives: bool,
    /// When data started flowing, and how much had come before.
    flowing: Option<(Instant, u64)>,
}

impl Meter {
    fn add(&mut self, bytes: u64) {
        self.received += bytes;
        if self.flowing.is_none() && self.received >= FLOWING {
            self.flowing = Some((Instant::now(), self.received));
        }
    }

    /// Speed since data started flowing.
    #[allow(clippy::cast_precision_loss)]
    fn kbps(&self) -> f64 {
        let (since, base) = self.flowing.unwrap_or((self.started, 0));
        (self.received - base) as f64 / 1000.0 / since.elapsed().as_secs_f64().max(0.001)
    }

    /// How long the next chunk may take.
    fn patience(&self) -> Duration {
        if self.flowing.is_some() {
            STALL
        } else {
            FIRST_BYTE
        }
    }

    /// Whether to give up on a slow mirror now.
    #[allow(clippy::cast_precision_loss)]
    fn too_slow(&self) -> bool {
        let Some((since, _)) = self.flowing else {
            return false;
        };
        if !self.alternatives || since.elapsed() < WARMUP {
            return false;
        }
        let kbps = self.kbps();
        if kbps >= MIN_KBPS {
            return false;
        }
        // Nearly there is worth finishing even when slow.
        let Some(total) = self.total else { return true };
        let left = total.saturating_sub(self.received) as f64 / 1000.0 / kbps.max(1.0);
        left > PATIENCE.as_secs_f64()
    }
}

async fn stream(
    request: reqwest::RequestBuilder,
    file: &mut tokio::fs::File,
    meter: &mut Meter,
    live: &Live,
    cancel: &CancellationToken,
) -> Result<(), FetchError> {
    let response = tokio::select! {
        () = cancel.cancelled() => return Err(FetchError::Cancelled),
        r = tokio::time::timeout(FIRST_BYTE, request.send()) => match r {
            Err(_) => return Err(FetchError::Unavailable("took too long to start sending".to_owned())),
            Ok(Err(e)) => return Err(FetchError::Unavailable(describe(&e))),
            Ok(Ok(r)) => r,
        },
    };
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(FetchError::RateLimited(super::sources::retry_after(&response)));
    }
    if matches!(status.as_u16(), 403 | 404 | 409 | 410 | 451) {
        let detail = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&detail)
            .ok()
            .and_then(|v| v.get("detail").or_else(|| v.get("error")).and_then(|d| d.as_str()).map(str::to_owned))
            .unwrap_or_else(|| format!("refused the file ({})", status.as_u16()));
        return Err(FetchError::NotOffered(detail));
    }
    if !status.is_success() {
        return Err(FetchError::Unavailable(format!("the file answered {}", status.as_u16())));
    }
    meter.total = response.content_length().filter(|&n| n > 0);
    let mut body = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            () = cancel.cancelled() => return Err(FetchError::Cancelled),
            c = tokio::time::timeout(meter.patience(), body.next()) => c,
        };
        let chunk = match chunk {
            Err(_) => return Err(FetchError::Unavailable("stopped sending".to_owned())),
            Ok(None) => return Ok(()),
            Ok(Some(Err(e))) => return Err(FetchError::Unavailable(describe(&e))),
            Ok(Some(Ok(chunk))) => chunk,
        };
        file.write_all(&chunk).await.map_err(|e| FetchError::Unavailable(e.to_string()))?;
        meter.add(chunk.len() as u64);
        live.progress(meter.received, meter.total);
        if meter.too_slow() {
            return Err(FetchError::Slow { kbps: meter.kbps() });
        }
        if meter.started.elapsed() > CAP {
            return Err(FetchError::Unavailable("took too long".to_owned()));
        }
    }
}
