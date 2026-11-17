//! Getting music into the folder: the app searches the catalog and asks for
//! a track; the server finds it on whichever source is working best right
//! now, falls back across sources and mirrors, checks the file, tags it and
//! files it in the music folder, where the scanner and analyser pick it up
//! and the next sync puts it on the stick.
//!
//! The server only ever adds files here; it never replaces or deletes one.

mod catalog;
mod db;
mod decrypt;
mod fetch;
pub mod health;
mod place;
mod sources;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use deckhand_model::downloads::{Attempt, CatalogTrack, Download, Downloads, Outcome, State};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use self::fetch::FetchError;
use self::health::{Event, Registry};
use self::sources::{Gate, LookupError, Source};
use crate::push::Push;
use crate::store::Store;
use crate::tags;

/// Downloads running at once. The sources are slow per connection rather
/// than in total, so two overlap well without crowding the Pi.
const CONCURRENT: usize = 2;
/// Mirrors of one source tried for one track before moving on.
const MIRRORS_PER_SOURCE: usize = 3;
/// A lookup that takes longer is a failure.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(20);
/// How often an idle server checks on mirrors nothing has used lately.
const PROBE_EVERY: Duration = Duration::from_secs(10 * 60);
const PROBE_STALE_MS: i64 = 30 * 60 * 1000;
/// A check is asked for at most this often.
const NAG_EVERY: Duration = Duration::from_secs(30 * 60);
/// How often the published mirror lists are re-read.
const REDISCOVER_EVERY: Duration = Duration::from_secs(60 * 60);

/// What a source is asked for.
#[derive(Debug, Clone, Default)]
pub struct Wanted {
    pub isrc: Option<String>,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    /// 0 when unknown.
    pub duration_sec: u32,
    /// Deezer's id, when the catalog is Deezer.
    pub deezer_id: Option<u64>,
    pub cover_url: Option<String>,
    /// Album-level tags.
    pub meta: tags::Meta,
}

impl Wanted {
    pub fn from_catalog(track: &CatalogTrack) -> Self {
        Self {
            isrc: track.isrc.clone(),
            title: track.title.clone(),
            artists: track.artists.clone(),
            album: track.album.clone(),
            duration_sec: track.duration_sec,
            deezer_id: track.id.strip_prefix("deezer:").and_then(|id| id.parse().ok()),
            cover_url: track.cover.clone(),
            meta: tags::Meta::default(),
        }
    }

    /// "Artist Title", for sources that only search by text.
    pub fn query(&self) -> String {
        format!("{} {}", self.artists.first().map_or("", String::as_str), self.title)
    }

    /// Whether a candidate's duration fits, when both are known.
    pub fn duration_fits(&self, secs: f64) -> bool {
        if self.duration_sec == 0 || secs <= 0.0 {
            return true;
        }
        let want = f64::from(self.duration_sec);
        (secs - want).abs() <= (want * 0.02).max(4.0)
    }
}

/// Live progress of one download, for the list.
#[derive(Clone, Default)]
pub struct Live(Arc<Mutex<(u64, Option<u64>)>>);

impl Live {
    pub fn progress(&self, received: u64, total: Option<u64>) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (received, total);
    }

    fn get(&self) -> (u64, Option<u64>) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone)]
pub struct Service {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    music: PathBuf,
    staging: PathBuf,
    http: reqwest::Client,
    sources: Vec<Arc<dyn Source>>,
    gates: Vec<Arc<dyn Gate>>,
    health: Registry,
    push: Push,
    ffmpeg: bool,
    wake: Notify,
    running: Mutex<HashMap<i64, (CancellationToken, Live)>>,
    /// When each gate last sent a notification.
    nagged: Mutex<HashMap<String, Instant>>,
}

/// Every source left that has the track sits behind a check only a person
/// can solve; carries the gates' ids.
#[derive(Debug)]
struct NeedsYou(Vec<String>);

impl std::fmt::Display for NeedsYou {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "waiting for the checks of {}", self.0.join(", "))
    }
}

impl std::error::Error for NeedsYou {}

impl Service {
    pub fn new(store: Store, music: PathBuf, data: &Path, push: Push) -> Result<Self> {
        let staging = data.join("downloads");
        // Leftovers of downloads a restart cut short.
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        let http = reqwest::Client::builder()
            .user_agent(concat!("Mozilla/5.0 (deckhand/", env!("CARGO_PKG_VERSION"), ")"))
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let health = Registry::load(store.clone())?;
        let ffmpeg = decrypt::have_ffmpeg();
        if !ffmpeg {
            warn!("ffmpeg is missing; the Amazon source is off");
        }
        let (sources, gates) = sources::all(&store, ffmpeg);
        Ok(Self {
            inner: Arc::new(Inner {
                sources,
                gates,
                store,
                music,
                staging,
                http,
                health,
                push,
                ffmpeg,
                wake: Notify::new(),
                running: Mutex::default(),
                nagged: Mutex::default(),
            }),
        })
    }

    /// Finds the mirrors, then starts the queue and the background checks.
    pub fn spawn(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            this.refresh_mirrors().await;
            let queue = this.clone();
            tokio::spawn(async move { queue.run_queue().await });
            let probes = this.clone();
            tokio::spawn(async move { probes.run_probes().await });
            loop {
                tokio::time::sleep(REDISCOVER_EVERY).await;
                this.refresh_mirrors().await;
            }
        });
    }

    async fn refresh_mirrors(&self) {
        let refreshes = self.inner.sources.iter().map(|s| s.refresh(&self.inner.http));
        futures_util::future::join_all(refreshes).await;
    }

    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<i64, (CancellationToken, Live)>> {
        self.inner.running.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn endpoints(&self) -> Vec<String> {
        self.inner
            .sources
            .iter()
            .flat_map(|s| s.mirrors().into_iter().map(|m| sources::endpoint(s.name(), &m)))
            .collect()
    }

    // MARK: API

    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<CatalogTrack>> {
        let store = self.inner.store.clone();
        let (isrcs, names) = tokio::task::spawn_blocking(move || -> Result<_> {
            let names = catalog::LibraryNames::new(store.all()?.into_iter().filter_map(|row| {
                let source: rbl_export::SourceTrack = serde_json::from_str(row.source.as_deref()?).ok()?;
                Some((row.name, source.title, source.artist))
            }));
            Ok((store.isrcs()?, names))
        })
        .await??;
        catalog::search(&self.inner.http, query, limit, &isrcs, &names).await
    }

    pub fn list(&self) -> Result<Downloads> {
        let mut downloads = db::list(&self.inner.store)?;
        let running = self.running();
        for d in &mut downloads {
            if let Some((_, live)) = running.get(&d.id) {
                (d.received, d.total) = live.get();
            }
        }
        drop(running);
        let waiting = db::count_waiting(&self.inner.store)?;
        Ok(Downloads {
            downloads,
            sources: self.inner.health.report(self.endpoints()),
            challenges: self.inner.gates.iter().map(|g| g.describe(waiting)).collect(),
        })
    }

    /// Takes the pass the app got by solving a check, and starts the
    /// downloads that were waiting for it.
    pub async fn solve(&self, gate: &str, solved: deckhand_model::downloads::Solved) -> Result<Result<(), String>> {
        let Some(gate) = self.inner.gates.iter().find(|g| g.id() == gate).cloned() else {
            return Ok(Err("No such check.".to_owned()));
        };
        let result = gate.solve(&self.inner.http, solved.pass, solved.remaining, solved.user_agent).await;
        if result.is_ok() {
            info!(gate = gate.id(), "check solved");
            self.nagged().remove(gate.id());
            let n = db::requeue_waiting(&self.inner.store)?;
            if n > 0 {
                info!(n, "downloads waiting for the check go again");
            }
            self.inner.wake.notify_one();
        }
        Ok(result)
    }

    /// "flacdownloader.com" for a gate id.
    fn site(&self, gate: &str) -> String {
        self.inner.gates.iter().find(|g| g.id() == gate).map_or_else(|| gate.to_owned(), |g| g.describe(0).site)
    }

    fn nagged(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.inner.nagged.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Asks the phone to solve a gate's check, at most every half hour.
    async fn nag(&self, gates: &[String], title: &str) {
        for gate in gates {
            {
                let mut nagged = self.nagged();
                if nagged.get(gate).is_some_and(|t| t.elapsed() < NAG_EVERY) {
                    continue;
                }
                nagged.insert(gate.clone(), Instant::now());
            }
            let site = self.site(gate);
            self.inner
                .push
                .alert(
                    "A download needs you",
                    &format!("{title} is only left on {site}, which wants a quick check first. Tap to solve it."),
                    serde_json::json!({ "challenge": gate }),
                )
                .await;
        }
    }

    /// Queues a track, unless it is already queued.
    pub fn add(&self, track: &CatalogTrack) -> Result<Download> {
        if let Some(existing) = db::active_for(&self.inner.store, &track.id)? {
            return Ok(existing);
        }
        let download = db::insert(&self.inner.store, track)?;
        info!(id = download.id, title = %track.title, "download queued");
        self.inner.wake.notify_one();
        Ok(download)
    }

    pub fn retry(&self, id: i64) -> Result<Option<Download>> {
        if db::requeue(&self.inner.store, id)? {
            self.inner.wake.notify_one();
        }
        db::get(&self.inner.store, id)
    }

    /// Stops a running download, or forgets a finished one.
    pub fn remove(&self, id: i64) -> Result<bool> {
        let Some(download) = db::get(&self.inner.store, id)? else {
            return Ok(false);
        };
        if download.state.is_active() {
            if let Some((cancel, _)) = self.running().get(&id) {
                cancel.cancel();
            }
            db::set_state(&self.inner.store, id, State::Cancelled, None)?;
            Ok(true)
        } else {
            db::delete(&self.inner.store, id)
        }
    }

    // MARK: Queue

    async fn run_queue(self) {
        loop {
            loop {
                let running: HashSet<i64> = self.running().keys().copied().collect();
                if running.len() >= CONCURRENT {
                    break;
                }
                match db::next_queued(&self.inner.store, &running) {
                    Ok(Some(id)) => {
                        self.running().insert(id, (CancellationToken::new(), Live::default()));
                        let this = self.clone();
                        tokio::spawn(async move {
                            this.process(id).await;
                            this.running().remove(&id);
                            this.inner.wake.notify_one();
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        warn!(error = %e, "could not read the download queue");
                        break;
                    }
                }
            }
            tokio::select! {
                () = self.inner.wake.notified() => {}
                () = tokio::time::sleep(Duration::from_secs(10)) => {}
            }
        }
    }

    async fn process(&self, id: i64) {
        let store = &self.inner.store;
        let Some((cancel, live)) = self.running().get(&id).cloned() else {
            return;
        };
        let download = match db::get(store, id) {
            Ok(Some(d)) if d.state == State::Queued => d,
            _ => return,
        };
        let result = self.acquire(&download, &cancel, &live).await;
        if cancel.is_cancelled() {
            return;
        }
        let saved = match result {
            Ok(Got { file, source, quality }) => {
                info!(id, %file, %source, "downloaded");
                db::done(store, id, &file, &source, quality.as_deref())
            }
            Err(e) => match e.downcast_ref::<NeedsYou>() {
                Some(needs) => {
                    info!(id, title = %download.track.title, "download waits for a check");
                    let sites: Vec<String> = needs.0.iter().map(|g| self.site(g)).collect();
                    let saved =
                        db::waiting(store, id, &format!("Waiting for you to solve {}'s check.", sites.join(" and ")));
                    self.nag(&needs.0, &download.track.title).await;
                    saved
                }
                None => {
                    warn!(id, title = %download.track.title, error = %e, "download failed");
                    db::failed(store, id, &e.to_string())
                }
            },
        };
        if let Err(e) = saved {
            warn!(id, error = %e, "could not record a download's result");
        }
    }

    async fn acquire(&self, download: &Download, cancel: &CancellationToken, live: &Live) -> Result<Got> {
        let (store, id) = (&self.inner.store, download.id);
        db::set_state(store, id, State::Searching, None)?;

        // The folder may have it already, from a playlist sync or by hand.
        if let Some(isrc) = &download.track.isrc {
            if let Some(file) = store.isrcs()?.get(isrc) {
                return Ok(Got { file: file.clone(), source: "library".to_owned(), quality: None });
            }
        }

        let want = catalog::details(&self.inner.http, &download.track).await;
        let cover = match &want.cover_url {
            Some(url) => self.cover(url).await,
            None => None,
        };

        let staged = self.inner.staging.join(format!("{id}.part"));
        let mut attempts: Vec<Attempt> = Vec::new();
        let result = self.try_sources(id, &want, &staged, cancel, live, &mut attempts).await;
        let _ = db::set_attempts(store, id, &attempts);
        let (source, probe, ext) = match result {
            Ok(found) => found,
            Err(e) => {
                let _ = std::fs::remove_file(&staged);
                return Err(e);
            }
        };

        db::set_state(store, id, State::Finishing, None)?;
        let mut meta = want.meta.clone();
        meta.title.clone_from(&want.title);
        meta.artists.clone_from(&want.artists);
        meta.album.clone_from(&want.album);
        meta.isrc.clone_from(&want.isrc);
        meta.cover = cover;
        let name = place::file_name(&want.title, &want.artists, ext);
        let music = self.inner.music.clone();
        let staged_for_task = staged.clone();
        let file = tokio::task::spawn_blocking(move || -> Result<String> {
            tags::write(&staged_for_task, &meta)?;
            place::place(&staged_for_task, &music, &name)
        })
        .await?;
        let _ = std::fs::remove_file(&staged);
        Ok(Got { file: file?, source, quality: Some(probe.quality()) })
    }

    /// Walks the sources best first until one delivers a file that checks
    /// out. Every source is asked at once up front, so a dead first choice
    /// costs no extra time before the next.
    async fn try_sources(
        &self,
        id: i64,
        want: &Wanted,
        staged: &Path,
        cancel: &CancellationToken,
        live: &Live,
        attempts: &mut Vec<Attempt>,
    ) -> Result<(String, tags::Probe, &'static str)> {
        let health = &self.inner.health;
        // Each source with its mirrors best first, sources by their best.
        let mut plan: Vec<(Arc<dyn Source>, Vec<String>)> = self
            .inner
            .sources
            .iter()
            .map(|s| {
                let mut ids: Vec<String> = s.mirrors().iter().map(|m| sources::endpoint(s.name(), m)).collect();
                health.rank(&mut ids);
                let mirrors = ids
                    .iter()
                    .filter_map(|id| s.mirrors().into_iter().find(|m| &sources::endpoint(s.name(), m) == id))
                    .take(MIRRORS_PER_SOURCE)
                    .collect();
                (s.clone(), mirrors)
            })
            .filter(|(_, mirrors): &(_, Vec<String>)| !mirrors.is_empty())
            .collect();
        plan.sort_by(|(a, am), (b, bm)| {
            let now = crate::store::now_ms();
            let cost = |s: &Arc<dyn Source>, m: &[String]| health.get(&sources::endpoint(s.name(), &m[0])).cost(now);
            cost(a, am).total_cmp(&cost(b, bm))
        });
        if plan.is_empty() {
            anyhow::bail!("no download sources are configured");
        }

        let mut early: HashMap<&'static str, tokio::task::JoinHandle<Looked>> = HashMap::new();
        for (source, mirrors) in &plan {
            let (source, mirror, http, want) =
                (source.clone(), mirrors[0].clone(), self.inner.http.clone(), want.clone());
            early.insert(source.name(), tokio::spawn(async move { lookup(&*source, &http, &mirror, &want).await }));
        }

        let last = plan.len() - 1;
        let mut not_found = 0;
        let mut blocked: Vec<String> = Vec::new();
        for (i, (source, mirrors)) in plan.iter().enumerate() {
            for (j, mirror) in mirrors.iter().enumerate() {
                if cancel.is_cancelled() {
                    anyhow::bail!("cancelled");
                }
                let endpoint = sources::endpoint(source.name(), mirror);
                let started = Instant::now();
                let (found, latency_ms) = match (j, early.remove(source.name())) {
                    (0, Some(handle)) => handle.await.unwrap_or((Err(LookupError::Unavailable("crashed".into())), 0.0)),
                    _ => lookup(&**source, &self.inner.http, mirror, want).await,
                };
                // Found: now ask for the file itself, which some sources
                // charge for (a token, a solved check).
                let found = match found {
                    Ok(found) => {
                        health.record(&endpoint, Event::Answered { latency_ms });
                        match tokio::time::timeout(LOOKUP_TIMEOUT, source.resolve(&self.inner.http, found, want)).await
                        {
                            Ok(resolved) => resolved,
                            Err(_) => Err(LookupError::Unavailable("took too long to hand out the file".to_owned())),
                        }
                    }
                    Err(e @ (LookupError::NotFound(_) | LookupError::NeedsYou(_))) => {
                        health.record(&endpoint, Event::Answered { latency_ms });
                        Err(e)
                    }
                    Err(e) => Err(e),
                };
                let found = match found {
                    Ok(found) => found,
                    Err(LookupError::NotFound(why)) => {
                        attempts.push(attempt(&endpoint, Outcome::NotFound, why, started));
                        not_found += 1;
                        // Every mirror of a service has the same catalogue.
                        break;
                    }
                    Err(LookupError::NeedsYou(gate)) => {
                        attempts.push(attempt(
                            &endpoint,
                            Outcome::NeedsYou,
                            "has it, once you solve its check".to_owned(),
                            started,
                        ));
                        if !blocked.contains(&gate) {
                            blocked.push(gate);
                        }
                        break;
                    }
                    Err(LookupError::Unavailable(why)) => {
                        health.record(&endpoint, Event::Failed { error: why.clone() });
                        attempts.push(attempt(&endpoint, Outcome::Unavailable, why, started));
                        continue;
                    }
                    Err(LookupError::RateLimited(secs)) => {
                        health.record(&endpoint, Event::RateLimited { secs });
                        attempts.push(attempt(&endpoint, Outcome::Unavailable, "rate limited".to_owned(), started));
                        continue;
                    }
                };

                db::set_state(&self.inner.store, id, State::Downloading, Some(source.name()))?;
                let alternatives = i < last || j + 1 < mirrors.len();
                match fetch::fetch(&self.inner.http, &found.media, staged, live, cancel, alternatives).await {
                    Ok(fetched) => {
                        let mut checked = match &found.decrypt {
                            Some(cipher) => decrypt::decrypt(staged, cipher).await,
                            None => Ok(()),
                        };
                        // Some services wrap FLAC in MP4; unwrap it.
                        if checked.is_ok()
                            && self.inner.ffmpeg
                            && tags::probe(staged).is_ok_and(|p| p.file_type == lofty::file::FileType::Mp4)
                        {
                            checked = decrypt::unwrap_mp4(staged).await;
                        }
                        let checked = checked.and_then(|()| check(staged, want));
                        match checked {
                            Ok(probe) => {
                                health
                                    .record(&endpoint, Event::Downloaded { bytes: fetched.bytes, secs: fetched.secs });
                                attempts.push(attempt(&endpoint, Outcome::Ok, probe.quality(), started));
                                return Ok((source.name().to_owned(), probe, found.ext));
                            }
                            Err(why) => {
                                let why = format!("{why:#}");
                                health.record(&endpoint, Event::BadFile { error: why.clone() });
                                attempts.push(attempt(&endpoint, Outcome::BadFile, why, started));
                            }
                        }
                    }
                    Err(FetchError::Cancelled) => anyhow::bail!("cancelled"),
                    Err(FetchError::NotOffered(why)) => {
                        // The mirror works; the service will not hand this one out.
                        health.record(&endpoint, Event::Answered { latency_ms });
                        attempts.push(attempt(&endpoint, Outcome::NotFound, why, started));
                        not_found += 1;
                        db::set_state(&self.inner.store, id, State::Searching, None)?;
                        break;
                    }
                    Err(FetchError::Slow { kbps }) => {
                        let why = format!("too slow ({kbps:.0} kB/s)");
                        health.record(&endpoint, Event::Slow { kbps, error: why.clone() });
                        attempts.push(attempt(&endpoint, Outcome::Unavailable, why, started));
                    }
                    Err(FetchError::Unavailable(why)) => {
                        health.record(&endpoint, Event::Failed { error: why.clone() });
                        attempts.push(attempt(&endpoint, Outcome::Unavailable, why, started));
                    }
                    Err(FetchError::RateLimited(secs)) => {
                        health.record(&endpoint, Event::RateLimited { secs });
                        attempts.push(attempt(&endpoint, Outcome::Unavailable, "rate limited".to_owned(), started));
                    }
                }
                db::set_state(&self.inner.store, id, State::Searching, None)?;
                let _ = db::set_attempts(&self.inner.store, id, attempts);
            }
        }
        for handle in early.into_values() {
            handle.abort();
        }
        if !blocked.is_empty() {
            return Err(NeedsYou(blocked).into());
        }
        if not_found == plan.len() {
            anyhow::bail!("No source has this track.");
        }
        anyhow::bail!("Every source that has it failed. It is retried when you ask again.")
    }

    async fn cover(&self, url: &str) -> Option<Vec<u8>> {
        let response = self.inner.http.get(url).timeout(Duration::from_secs(15)).send().await.ok()?;
        let bytes = response.error_for_status().ok()?.bytes().await.ok()?;
        (bytes.len() > 1000).then(|| bytes.to_vec())
    }

    // MARK: Probes

    /// Keeps the ranking honest while nothing is downloading: asks each
    /// mirror not used lately for a well-known track, which also brings a
    /// rested mirror back once it answers again.
    async fn run_probes(self) {
        let reference = Wanted {
            isrc: Some("GBDUW0000059".to_owned()),
            title: "Harder, Better, Faster, Stronger".to_owned(),
            artists: vec!["Daft Punk".to_owned()],
            album: "Discovery".to_owned(),
            duration_sec: 226,
            deezer_id: Some(3_135_556),
            ..Wanted::default()
        };
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if self.running().is_empty() {
                let now = crate::store::now_ms();
                let mut checks = Vec::new();
                for source in &self.inner.sources {
                    for mirror in source.mirrors() {
                        let endpoint = sources::endpoint(source.name(), &mirror);
                        let h = self.inner.health.get(&endpoint);
                        let recent = [h.last_ok_ms, h.last_probe_ms].into_iter().flatten().max().unwrap_or(0);
                        if now - recent < PROBE_STALE_MS {
                            continue;
                        }
                        let (source, http, want, health) =
                            (source.clone(), self.inner.http.clone(), reference.clone(), self.inner.health.clone());
                        checks.push(async move {
                            let (result, latency_ms) = lookup(&*source, &http, &mirror, &want).await;
                            match result {
                                Ok(_) | Err(LookupError::NotFound(_) | LookupError::NeedsYou(_)) => {
                                    health.record(&endpoint, Event::Answered { latency_ms });
                                }
                                Err(LookupError::Unavailable(error)) => {
                                    health.record(&endpoint, Event::Failed { error })
                                }
                                Err(LookupError::RateLimited(secs)) => {
                                    health.record(&endpoint, Event::RateLimited { secs });
                                }
                            }
                            health.probed(&endpoint);
                        });
                    }
                }
                if !checks.is_empty() {
                    futures_util::future::join_all(checks).await;
                }
            }
            tokio::time::sleep(PROBE_EVERY).await;
        }
    }
}

struct Got {
    file: String,
    source: String,
    quality: Option<String>,
}

/// A lookup's answer and how long it took, in ms.
type Looked = (Result<sources::Found, LookupError>, f64);

async fn lookup(source: &dyn Source, http: &reqwest::Client, mirror: &str, want: &Wanted) -> Looked {
    let started = Instant::now();
    let result = match tokio::time::timeout(LOOKUP_TIMEOUT, source.lookup(http, mirror, want)).await {
        Ok(result) => result,
        Err(_) => Err(LookupError::Unavailable("took too long to answer".to_owned())),
    };
    (result, started.elapsed().as_secs_f64() * 1000.0)
}

fn attempt(endpoint: &str, outcome: Outcome, detail: String, started: Instant) -> Attempt {
    Attempt {
        source: endpoint.to_owned(),
        outcome,
        detail,
        ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

/// Is it the track, losslessly? Previews (30 s), wrong versions and lossy
/// files are caught here rather than on the decks.
fn check(path: &Path, want: &Wanted) -> Result<tags::Probe> {
    let probe = tags::probe(path).context("it isn't a readable audio file")?;
    if !probe.is_lossless() {
        anyhow::bail!("it sent a lossy file ({})", probe.quality());
    }
    if !want.duration_fits(probe.duration_sec) {
        anyhow::bail!("it is {:.0} s long, the track is {} s", probe.duration_sec, want.duration_sec);
    }
    Ok(probe)
}
