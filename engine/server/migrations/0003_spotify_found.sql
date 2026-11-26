-- A playlist's recording found in the music folder by its title and artist
-- (a file whose ISRC tag differs, or has none) is remembered, because the
-- name the engine sees is Spotidata's and can change under it: Spotify names
-- some tracks differently by endpoint, and a sync rewrites the stored name.
-- Without this, a renamed track reads as missing and is downloaded again.

create table deckhand.spotify_found (
    key         text primary key,
    file        text collate "C" not null,
    found_at    timestamptz not null default now()
);
comment on table deckhand.spotify_found is
    'The file a kept playlist''s recording (isrc:<ISRC>, else spotify:<id>) was found in by its title and artist, '
    'so the match outlasts Spotify renaming the track. Used while the file is in the folder.';

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'spotidata_mcp') then
        grant select on deckhand.spotify_found to spotidata_mcp;
    end if;
end $$;
