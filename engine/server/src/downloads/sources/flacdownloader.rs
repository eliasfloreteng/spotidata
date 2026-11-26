//! flacdownloader.com: Tidal, Qobuz and Deezer, behind a Cloudflare Turnstile
//! check. Searching is open; each file needs a one-use token from
//! `POST /prepare`, which takes either a solved Turnstile (`{cf}`) or the
//! session pass a solved one returns (`{sp}`). The pass lasts a while and a
//! number of downloads, so the check is solved once on the phone (the app's
//! challenge sheet posts the pass to `/api/challenges/flacdownloader`) and
//! the server then gets tokens on its own until the pass runs out.

use std::sync::{Arc, RwLock};

use base64::Engine;
use deckhand_model::downloads::Challenge;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{json, same_track, Decrypt, Found, Gate, LookupError, Media, Source};
use crate::downloads::Wanted;
use crate::store::{now_ms, Store};

const SITE: &str = "https://flacdownloader.com";
const GATE: &str = "flacdownloader";
const META_KEY: &str = "flacdownloader_pass";
/// From the site's bundle (`turnstile.render({sitekey})`).
const SITEKEY: &str = "0x4AAAAAAD2MQMVORZcldmdE";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Pass {
    sp: String,
    expires_ms: Option<i64>,
    remaining: Option<u32>,
    /// The browser it was solved in; the server poses as it.
    user_agent: String,
}

impl Pass {
    /// The pass starts with base64 "<expiry seconds>:…".
    fn expiry(sp: &str) -> Option<i64> {
        let head = sp.split('.').next()?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(head.trim_end_matches('='))
            .or_else(|_| base64::engine::general_purpose::STANDARD.decode(head))
            .ok()?;
        let text = String::from_utf8(bytes).ok()?;
        text.split(':').next()?.parse::<i64>().ok().map(|s| s * 1000)
    }

    fn usable(&self) -> bool {
        !self.sp.is_empty() && self.expires_ms.is_none_or(|t| t > now_ms()) && self.remaining.is_none_or(|n| n > 0)
    }
}

/// The pass, shared by the three services.
pub struct Session {
    store: Store,
    pass: RwLock<Option<Pass>>,
}

impl Session {
    pub async fn load(store: Store) -> Arc<Self> {
        let pass = store.meta::<Option<Pass>>(META_KEY).await.ok().flatten().flatten();
        Arc::new(Self { store, pass: RwLock::new(pass) })
    }

    fn get(&self) -> Option<Pass> {
        self.pass.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone().filter(Pass::usable)
    }

    async fn set(&self, pass: Option<Pass>) {
        if let Err(e) = self.store.set_meta(META_KEY, &pass).await {
            tracing::warn!(error = %e, "could not keep the flacdownloader pass");
        }
        *self.pass.write().unwrap_or_else(std::sync::PoisonError::into_inner) = pass;
    }

    fn user_agent(&self) -> String {
        self.get().map(|p| p.user_agent).filter(|ua| !ua.is_empty()).unwrap_or_else(|| {
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
                .to_owned()
        })
    }

    fn request(&self, http: &reqwest::Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        http.request(method, format!("{SITE}{path}"))
            .header(reqwest::header::USER_AGENT, self.user_agent())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::REFERER, format!("{SITE}/download"))
            .header(reqwest::header::ORIGIN, SITE)
            .timeout(std::time::Duration::from_secs(20))
    }

    /// A one-use download token, spending the pass.
    async fn token(&self, http: &reqwest::Client) -> Result<String, LookupError> {
        let Some(mut pass) = self.get() else {
            return Err(LookupError::NeedsYou(GATE.to_owned()));
        };
        let response =
            self.request(http, reqwest::Method::POST, "/prepare").json(&json!({ "sp": pass.sp })).send().await?;
        match response.status().as_u16() {
            200 => {}
            429 => return Err(LookupError::RateLimited(super::retry_after(&response))),
            401 | 403 => {
                // Spent or refused: the next download asks for a new check.
                self.set(None).await;
                return Err(LookupError::NeedsYou(GATE.to_owned()));
            }
            status => return Err(LookupError::Unavailable(format!("answered {status}"))),
        }
        let answer: Value =
            response.json().await.map_err(|_| LookupError::Unavailable("answered something unreadable".to_owned()))?;
        let token = answer
            .get("t")
            .and_then(Value::as_str)
            .ok_or_else(|| LookupError::Unavailable("gave no token".to_owned()))?
            .to_owned();
        if let Some(sp) = answer.get("sp").and_then(Value::as_str).filter(|sp| !sp.is_empty()) {
            pass.expires_ms = Pass::expiry(sp).or(pass.expires_ms);
            pass.sp = sp.to_owned();
        }
        pass.remaining = answer.get("quedan").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
        self.set(Some(pass)).await;
        Ok(token)
    }
}

impl Gate for Session {
    fn id(&self) -> &'static str {
        GATE
    }

    fn describe(&self, waiting: usize) -> Challenge {
        let pass = self.get();
        Challenge {
            id: GATE.to_owned(),
            site: "flacdownloader.com".to_owned(),
            page: format!("{SITE}/download"),
            sitekey: SITEKEY.to_owned(),
            waiting,
            solved: pass.is_some(),
            expires_ms: pass.as_ref().and_then(|p| p.expires_ms),
            remaining: pass.and_then(|p| p.remaining),
        }
    }

    fn solve<'a>(
        &'a self,
        http: &'a reqwest::Client,
        pass: String,
        remaining: Option<u32>,
        user_agent: String,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pass = Pass { expires_ms: Pass::expiry(&pass), sp: pass, remaining, user_agent };
            if !pass.usable() {
                return Err("That pass has already run out.".to_owned());
            }
            self.set(Some(pass)).await;
            // Proves the site takes it from the server too; the token is
            // spent, which a download would have done anyway.
            match self.token(http).await {
                Ok(_) => Ok(()),
                Err(LookupError::NeedsYou(_)) => Err(
                    "The site accepted the check on your phone but not from the server. It may tie passes to the network they were solved on.".to_owned(),
                ),
                Err(e) => Err(format!("The server couldn't confirm the pass: {e}")),
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Tidal,
    Qobuz,
    Deezer,
}

pub struct FlacDownloader {
    route: Route,
    session: Arc<Session>,
}

impl FlacDownloader {
    pub fn new(route: Route, session: Arc<Session>) -> Self {
        Self { route, session }
    }

    fn artists(item: &Value) -> Vec<&str> {
        let mut names: Vec<&str> = item
            .get("artists")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        if let Some(name) = item.get("artist").and_then(Value::as_str) {
            names.push(name);
        }
        names
    }

    /// The service's own track, from the site's search.
    async fn search(&self, http: &reqwest::Client, want: &Wanted) -> Result<Value, LookupError> {
        let path = match self.route {
            Route::Tidal => "/api/tidal/search",
            Route::Qobuz => "/api/qobuz/search",
            Route::Deezer => unreachable!("Deezer ids come with the catalog"),
        };
        let mut queries: Vec<String> = want.isrc.iter().cloned().collect();
        queries.push(want.query());
        for q in queries {
            let response = self
                .session
                .request(http, reqwest::Method::GET, path)
                .query(&[("q", q.as_str()), ("offset", "0")])
                .send()
                .await?;
            let found = json(response).await?;
            let hit = found.get("tracks").and_then(Value::as_array).and_then(|tracks| {
                tracks.iter().find(|t| {
                    t.get("lossless").and_then(Value::as_bool).unwrap_or(true)
                        && same_track(
                            want,
                            t.get("isrc").and_then(Value::as_str),
                            t.get("title").and_then(Value::as_str).unwrap_or_default(),
                            &Self::artists(t),
                            t.get("durationMs").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
                        )
                })
            });
            if let Some(hit) = hit {
                return Ok(hit.clone());
            }
        }
        Err(LookupError::NotFound("not in its catalogue".to_owned()))
    }

    /// Qobuz's id for 16-bit FLAC, as the site lists formats.
    async fn qobuz_format(&self, http: &reqwest::Client, track: &Value) -> Result<String, LookupError> {
        let url = track.get("url").and_then(Value::as_str).unwrap_or_default();
        let response = self
            .session
            .request(http, reqwest::Method::GET, "/api/qobuz/formats")
            .query(&[("url", url)])
            .send()
            .await?;
        let formats = json(response).await?;
        let list = formats.get("formats").and_then(Value::as_array).cloned().unwrap_or_default();
        let id = |f: &Value| f.get("id").map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
        list.iter()
            .find(|f| f.get("desc").and_then(Value::as_str).is_some_and(|d| d.starts_with("16")))
            .or_else(|| {
                list.iter().find(|f| f.get("label").and_then(Value::as_str).is_some_and(|l| l.contains("FLAC")))
            })
            .and_then(id)
            .ok_or_else(|| LookupError::NotFound("offers no FLAC".to_owned()))
    }
}

impl Source for FlacDownloader {
    fn name(&self) -> &'static str {
        match self.route {
            Route::Tidal => "fd-tidal",
            Route::Qobuz => "fd-qobuz",
            Route::Deezer => "fd-deezer",
        }
    }

    fn mirrors(&self) -> Vec<String> {
        vec![SITE.to_owned()]
    }

    /// Finds the track without spending the pass.
    fn lookup<'a>(
        &'a self,
        http: &'a reqwest::Client,
        _mirror: &'a str,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>> {
        Box::pin(async move {
            let track = match self.route {
                Route::Deezer => {
                    let id = want.deezer_id.ok_or_else(|| LookupError::NotFound("no Deezer id".to_owned()))?;
                    json!({ "url": format!("https://www.deezer.com/track/{id}") })
                }
                Route::Tidal | Route::Qobuz => self.search(http, want).await?,
            };
            Ok(Found { media: Media::Pending(track), decrypt: None, ext: "flac" })
        })
    }

    /// Spends a token on the file link.
    fn resolve<'a>(
        &'a self,
        http: &'a reqwest::Client,
        found: Found,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>> {
        Box::pin(async move {
            let Media::Pending(track) = found.media else {
                return Ok(found);
            };
            let text = |k: &str| track.get(k).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
            let (path, body) = match self.route {
                Route::Tidal => (
                    "/tidal-asset",
                    json!({
                        "url": text("url").unwrap_or_default(),
                        "id": text("id").unwrap_or_default(),
                        "title": want.title, "artist": want.artists.join(", "), "album": want.album,
                        "isrc": want.isrc.clone().unwrap_or_default(),
                        "duration": want.duration_sec, "explicit": false, "formatId": "LOSSLESS",
                    }),
                ),
                Route::Qobuz => {
                    let format = self.qobuz_format(http, &track).await?;
                    (
                        "/qobuz-asset",
                        json!({
                            "url": text("url").unwrap_or_default(),
                            "title": want.title, "artist": want.artists.join(", "), "album": want.album,
                            "isrc": want.isrc.clone().unwrap_or_default(),
                            "duration": want.duration_sec, "explicit": false, "formatId": format,
                        }),
                    )
                }
                Route::Deezer => (
                    "/asset",
                    json!({
                        "url": text("url").unwrap_or_default(),
                        "title": want.title, "artist": want.artists.join(", "),
                        "format": "flac", "accept_fallback": false,
                    }),
                ),
            };
            let token = self.session.token(http).await?;
            let response = self
                .session
                .request(http, reqwest::Method::POST, path)
                .header("X-DL-Token", token)
                .json(&body)
                .send()
                .await?;
            if response.status() == reqwest::StatusCode::CONFLICT {
                return Err(LookupError::NotFound("has no lossless copy".to_owned()));
            }
            if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                return Err(LookupError::Unavailable("has no working account right now".to_owned()));
            }
            let asset = json(response).await?;
            if let Some(error) = asset.get("error").and_then(Value::as_str) {
                return Err(LookupError::Unavailable(format!("refused: {error}")));
            }
            let url = asset
                .get("u")
                .and_then(Value::as_str)
                .ok_or_else(|| LookupError::Unavailable("gave no link".to_owned()))?
                .to_owned();
            let decrypt = match (self.route, asset.get("k").and_then(Value::as_str)) {
                (Route::Deezer, Some(hex)) => Some(Decrypt::DeezerBlowfish {
                    key: (0..hex.len() / 2)
                        .filter_map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
                        .collect(),
                }),
                (Route::Deezer, None) => return Err(LookupError::Unavailable("gave no key".to_owned())),
                _ => None,
            };
            Ok(Found { media: Media::Url { url, headers: vec![] }, decrypt, ext: "flac" })
        })
    }
}
