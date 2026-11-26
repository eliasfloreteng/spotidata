-- Deckhand's engine: the music folder and its analysis, the downloads, the
-- download sources' health, the phones to notify and the Spotify playlists
-- it keeps. deckhand-server owns this schema and is the only one writing to
-- it; others may read it. Times are timestamptz; the HTTP API turns them into
-- the apps' `*_ms` fields.

create table deckhand.files (
    name        text collate "C" primary key,
    size        bigint not null check (size >= 0),
    mtime       timestamptz not null,
    hash        text not null check (hash ~ '^[0-9a-f]{64}$'),
    first_seen  timestamptz not null default now(),
    state       text not null check (state in ('other', 'pending', 'ready', 'failed')),
    error       text,
    source      jsonb check (jsonb_typeof(source) = 'object'),
    isrc        text check (isrc <> '' and isrc = upper(isrc)),
    isrc_read   boolean not null default false,
    origin      text check (origin in ('rbxport', 'rekordbox')),
    dat         text check (dat ~ '^[0-9a-f]{64}$'),
    ext         text check (ext ~ '^[0-9a-f]{64}$'),
    two_ex      text check (two_ex ~ '^[0-9a-f]{64}$'),
    art_small   text check (art_small ~ '^[0-9a-f]{64}$'),
    art_medium  text check (art_medium ~ '^[0-9a-f]{64}$'),
    recipe      integer not null default 0,
    bpm         numeric(7, 2) generated always as (nullif((source ->> 'bpm_x100')::numeric, 0) / 100) stored,
    musical_key text generated always as (nullif(source ->> 'key', '')) stored,
    check ((origin is null) = (dat is null)),
    check ((art_small is null) = (art_medium is null)),
    check (isrc is null or isrc_read)
);
comment on table deckhand.files is
    'Every file of the music folder: audio and its analysis, and the .m3u8 playlists (state other).';
comment on column deckhand.files.name is 'The file name in the flat music folder.';
comment on column deckhand.files.hash is 'BLAKE3 of the content, hex.';
comment on column deckhand.files.mtime is 'The file''s modification time.';
comment on column deckhand.files.first_seen is 'When the scanner first saw a file of this name.';
comment on column deckhand.files.state is
    'other: not audio; pending: waiting for analysis; ready: analysed; failed: analysis failed (error says why).';
comment on column deckhand.files.source is
    'The track as the stick gets it (rbxport''s SourceTrack, JSON): tags, then analysis or rekordbox''s facts on top.';
comment on column deckhand.files.isrc is 'The recording the file holds, from its ISRC tag; null when it has none.';
comment on column deckhand.files.isrc_read is 'Whether the file''s ISRC tag has been read (isrc is then null only if it has none).';
comment on column deckhand.files.origin is 'Whose analysis the dat/ext/two_ex blobs are: rbxport''s or rekordbox''s.';
comment on column deckhand.files.dat is 'The ANLZ .DAT blob (beat grid, waveform), by BLAKE3 hash in the data dir''s blobs/.';
comment on column deckhand.files.ext is 'The ANLZ .EXT blob, by hash.';
comment on column deckhand.files.two_ex is 'The ANLZ .2EX blob, by hash.';
comment on column deckhand.files.art_small is 'The 80 px cover (JPEG blob), by hash.';
comment on column deckhand.files.art_medium is 'The 240 px cover (JPEG blob), by hash.';
comment on column deckhand.files.recipe is 'The analysis recipe it was analysed with; older ones are analysed again.';
comment on column deckhand.files.bpm is 'Tempo, from the analysis when state is ready (else the tags''); null when unknown.';
comment on column deckhand.files.musical_key is 'Musical key, from the analysis when state is ready (else the tags''); null when unknown.';
create index files_hash on deckhand.files (hash);
create index files_isrc on deckhand.files (isrc) where isrc is not null;
create index files_pending on deckhand.files (mtime desc) where state = 'pending';
create index files_isrc_unread on deckhand.files (name) where not isrc_read and state <> 'other';

create table deckhand.tombstones (
    name        text collate "C" primary key,
    size        bigint not null check (size >= 0),
    deleted_at  timestamptz not null
);
comment on table deckhand.tombstones is
    'Files that left the music folder, so a stick deletes only a file of the same name and size.';

create table deckhand.meta (
    key         text primary key,
    value       jsonb not null
);
comment on table deckhand.meta is
    'Settings and small state: downloads.aiff, spotify.paused, rekordbox.db_id, rekordbox.cloud_db_id, '
    'rekordbox.snapshot_at, antra_manifest, flacdownloader_pass.';

create table deckhand.rekordbox (
    name        text collate "C" primary key,
    facts       jsonb not null check (jsonb_typeof(facts) = 'object')
);
comment on table deckhand.rekordbox is
    'What the last uploaded rekordbox library says about each file name (NFC): its content id, cues, '
    'tempo and key, and the analysis blobs when rekordbox analysed it.';

create table deckhand.downloads (
    id          bigint generated always as identity primary key,
    catalog_id  text not null,
    track       jsonb not null check (jsonb_typeof(track) = 'object'),
    state       text not null check (state in
                    ('queued', 'searching', 'downloading', 'finishing', 'waiting', 'done', 'failed', 'cancelled')),
    source      text,
    quality     text,
    file        text,
    error       text,
    attempts    jsonb not null default '[]' check (jsonb_typeof(attempts) = 'array'),
    playlist    text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
comment on table deckhand.downloads is
    'Tracks asked for (in the app, or by a kept Spotify playlist) and files imported from the phone (source file).';
comment on column deckhand.downloads.catalog_id is
    'The catalog track: deezer:<id>, spotify:<id> when Deezer lacks it, file:<hash> for an import.';
comment on column deckhand.downloads.track is 'The catalog track (title, artists, album, isrc, duration_sec, cover), JSON.';
comment on column deckhand.downloads.state is
    'queued, searching, downloading, finishing: under way; waiting: for a check solved in the app; '
    'done; failed (error says why); cancelled.';
comment on column deckhand.downloads.source is 'The source being tried, or the one that delivered the file.';
comment on column deckhand.downloads.file is 'The file in the music folder (deckhand.files.name), once done.';
comment on column deckhand.downloads.attempts is 'Every source tried, in order: source, outcome, detail, ms.';
comment on column deckhand.downloads.playlist is 'The name of the Spotify playlist it was got for; null when asked for in the app.';
create index downloads_catalog on deckhand.downloads (catalog_id, id desc);
create index downloads_active on deckhand.downloads (id)
    where state in ('queued', 'searching', 'downloading', 'finishing', 'waiting');
create index downloads_updated on deckhand.downloads (updated_at);

create table deckhand.endpoints (
    id              text primary key,
    reliability     double precision not null check (reliability >= 0),
    speed_kbps      double precision check (speed_kbps >= 0),
    latency_ms      double precision not null check (latency_ms >= 0),
    downloads       bigint not null default 0 check (downloads >= 0),
    failures_in_row integer not null default 0 check (failures_in_row >= 0),
    resting_until   timestamptz,
    last_error      text,
    last_ok         timestamptz,
    last_probe      timestamptz
);
comment on table deckhand.endpoints is
    'How each mirror of each download source has been doing (running averages); the next download tries the cheapest first.';
comment on column deckhand.endpoints.id is '<source>:<host>.';
comment on column deckhand.endpoints.reliability is 'Running average of whether it worked, 0 to 1.';
comment on column deckhand.endpoints.resting_until is 'Tried only after the rest until then, after failing.';

create table deckhand.devices (
    token       text primary key check (token ~ '^[0-9a-fA-F]{64,}$'),
    environment text not null check (environment in ('production', 'development')),
    updated_at  timestamptz not null default now()
);
comment on table deckhand.devices is 'Phones to notify through APNs, by device token.';

create table deckhand.spotify_playlists (
    id              text primary key,
    name            text not null,
    owner           text not null default '',
    owned           boolean not null default false,
    image           text,
    total           integer not null default 0 check (total >= 0),
    snapshot        text not null default '',
    position        integer not null default 0,
    gone            boolean not null default false,
    selected        boolean not null default false,
    read_snapshot   text,
    read_at         timestamptz,
    file            text,
    file_hash       text,
    error           text,
    linked_at       timestamptz,
    check ((file is null) = (file_hash is null))
);
comment on table deckhand.spotify_playlists is
    'The account''s Spotify playlists, and the ones added by their link; selected ones are kept in the music folder.';
comment on column deckhand.spotify_playlists.snapshot is 'Spotify''s snapshot_id as last listed.';
comment on column deckhand.spotify_playlists.read_snapshot is 'The snapshot its tracks were last read at.';
comment on column deckhand.spotify_playlists.position is 'Its place in the account''s list; linked ones after.';
comment on column deckhand.spotify_playlists.gone is 'No longer listed by the account (or shown by Spotify, for a linked one).';
comment on column deckhand.spotify_playlists.selected is 'Kept: its tracks are downloaded and its .m3u8 written.';
comment on column deckhand.spotify_playlists.file is 'The .m3u8 written for it in the music folder.';
comment on column deckhand.spotify_playlists.file_hash is 'A hash of what was written, to tell whether it was edited since.';
comment on column deckhand.spotify_playlists.linked_at is 'When it was added by its link; null for one picked from the account''s list.';

create table deckhand.spotify_tracks (
    playlist    text not null references deckhand.spotify_playlists (id) on delete cascade,
    position    integer not null check (position >= 0),
    track       jsonb not null check (jsonb_typeof(track) = 'object'),
    primary key (playlist, position)
);
comment on table deckhand.spotify_tracks is
    'A playlist''s tracks as last read, in Spotify''s order: id, title, artists, album, isrc, duration_ms, cover (JSON).';

create table deckhand.spotify_links (
    key         text primary key,
    download    bigint not null references deckhand.downloads (id) on delete cascade
);
comment on table deckhand.spotify_links is
    'The download last started for a playlist''s recording, by its key (isrc:<ISRC>, else spotify:<id>).';
create index spotify_links_download on deckhand.spotify_links (download);

create table deckhand.spotify_activity (
    id          bigint generated always as identity primary key,
    at          timestamptz not null default now(),
    kind        text not null check (kind in
                    ('kept', 'dropped', 'read', 'changed', 'queued', 'retried', 'landed',
                     'failed', 'recovered', 'paused', 'resumed')),
    playlist    text references deckhand.spotify_playlists (id) on delete set null,
    name        text,
    count       integer not null default 0 check (count >= 0),
    added       integer not null default 0 check (added >= 0),
    removed     integer not null default 0 check (removed >= 0),
    detail      text
);
comment on table deckhand.spotify_activity is
    'What the Spotify sync did, the last 500 entries; repeats close together are merged (at is the latest).';
create index spotify_activity_playlist on deckhand.spotify_activity (playlist, id desc);
