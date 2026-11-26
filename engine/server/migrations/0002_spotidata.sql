-- The engine moved into Spotidata's stack and database. Spotidata already
-- holds every playlist and its tracks (public.playlists, playlist_tracks) and
-- now reads the kept ones' changes itself, so the engine stops keeping a copy:
-- it reads them from Spotidata's views spotidata.engine_playlists and
-- spotidata.engine_playlist_tracks (db/sql/post/110_engine.sql), and keeps
-- only its own state here.

drop table deckhand.spotify_tracks;

alter table deckhand.spotify_playlists
    drop column owner,
    drop column owned,
    drop column image,
    drop column total,
    drop column snapshot,
    drop column position,
    drop column gone;
alter table deckhand.spotify_playlists rename column read_snapshot to seen_snapshot;
alter table deckhand.spotify_playlists rename column read_at to seen_at;
alter table deckhand.spotify_playlists
    add column seen_tracks text[] not null default '{}';

comment on table deckhand.spotify_playlists is
    'Spotify playlists kept (selected) or once kept, by Spotify id: what the engine did with them. '
    'What Spotify says about them is Spotidata''s, in spotidata.engine_playlists.';
comment on column deckhand.spotify_playlists.name is 'Its name as last seen, for the activity and once Spotify no longer has it.';
comment on column deckhand.spotify_playlists.selected is 'Kept: its tracks are downloaded and its .m3u8 written.';
comment on column deckhand.spotify_playlists.seen_snapshot is
    'The snapshot whose tracks the engine last compared, to tell what changed on Spotify.';
comment on column deckhand.spotify_playlists.seen_at is 'When that was.';
comment on column deckhand.spotify_playlists.seen_tracks is
    'The recordings at seen_snapshot, in order (isrc:<ISRC>, spotify:<id>, or local:<title>|<artists>).';
comment on column deckhand.spotify_playlists.error is 'Why it could not be read last time, if it could not.';
comment on column deckhand.spotify_playlists.linked_at is
    'When it was added by its link; null for one picked from the account''s list.';

-- Musical keys as the Camelot code a DJ sorts by. rekordbox writes the code
-- itself ("8A"), rbxport the key's name ("Abm", "F#").
create function deckhand.camelot(key text) returns text
language sql immutable parallel safe return case
    when key ~ '^(1[0-2]|[1-9])[AB]$' then key
    else case replace(replace(key, '♯', '#'), '♭', 'b')
        when 'Abm' then '1A' when 'G#m' then '1A'
        when 'Ebm' then '2A' when 'D#m' then '2A'
        when 'Bbm' then '3A' when 'A#m' then '3A'
        when 'Fm' then '4A'
        when 'Cm' then '5A'
        when 'Gm' then '6A'
        when 'Dm' then '7A'
        when 'Am' then '8A'
        when 'Em' then '9A'
        when 'Bm' then '10A' when 'Cbm' then '10A'
        when 'F#m' then '11A' when 'Gbm' then '11A'
        when 'Dbm' then '12A' when 'C#m' then '12A'
        when 'B' then '1B' when 'Cb' then '1B'
        when 'F#' then '2B' when 'Gb' then '2B'
        when 'Db' then '3B' when 'C#' then '3B'
        when 'Ab' then '4B' when 'G#' then '4B'
        when 'Eb' then '5B' when 'D#' then '5B'
        when 'Bb' then '6B' when 'A#' then '6B'
        when 'F' then '7B'
        when 'C' then '8B'
        when 'G' then '9B'
        when 'D' then '10B'
        when 'A' then '11B'
        when 'E' then '12B'
    end
end;
comment on function deckhand.camelot(text) is 'A musical key (rekordbox''s Camelot code or rbxport''s key name) as its Camelot code.';

-- One file per recording. Of two files with one ISRC, the engine uses the one
-- the scanner saw last (Store::isrcs reads this view), and so does everyone
-- else who reads it.
create view deckhand.recordings as
    select distinct on (isrc)
           isrc,
           name as file,
           state,
           case when state = 'ready' then bpm end as bpm,
           case when state = 'ready' then musical_key end as musical_key,
           case when state = 'ready' then deckhand.camelot(musical_key) end as camelot,
           case when state = 'ready' then origin end as analysis,
           size,
           first_seen
      from deckhand.files
     where isrc is not null
     order by isrc, first_seen desc, name desc;
comment on view deckhand.recordings is
    'The file that holds each recording (by ISRC) in the music folder, with its tempo and key once analysed.';
comment on column deckhand.recordings.file is 'The file (deckhand.files.name).';
comment on column deckhand.recordings.state is 'pending: waiting for analysis; ready: analysed; failed.';
comment on column deckhand.recordings.bpm is 'Tempo, from the analysis; null until state is ready, or when unknown.';
comment on column deckhand.recordings.musical_key is 'The key as the analysis wrote it; null until state is ready, or when unknown.';
comment on column deckhand.recordings.camelot is 'The key as a Camelot code, once analysed; null when unknown.';
comment on column deckhand.recordings.analysis is
    'Whose analysis the tempo and key are, once analysed: rekordbox''s (uploaded from the Mac) or rbxport''s.';

-- Spotidata's read-only MCP role reads what describes the library. Not the
-- phones to notify (devices), and not meta, which holds the download
-- sources' passes.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'spotidata_mcp') then
        grant usage on schema deckhand to spotidata_mcp;
        grant select on deckhand.files, deckhand.recordings, deckhand.tombstones, deckhand.rekordbox,
            deckhand.downloads, deckhand.endpoints, deckhand.spotify_playlists, deckhand.spotify_links,
            deckhand.spotify_activity
            to spotidata_mcp;
        grant execute on function deckhand.camelot(text) to spotidata_mcp;
    end if;
end $$;
