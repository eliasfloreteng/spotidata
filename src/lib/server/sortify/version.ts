/**
 * When Sortify's own writes last changed the mirror or the eligibility rules.
 *
 * The sort engine keeps its snapshot in memory and rebuilds it when this moves
 * or when a sync has landed since (see `engine.ts`). A leaf module, imported by
 * both the writers and the engine, so neither has to import the other.
 */
let version = 0;
let addsSinceCatalog = 0;
let catalogVersion = 0;

export function bumpVersion(): void {
	version++;
}

export function currentVersion(): number {
	return version;
}

/**
 * The playlist catalog sent to the model is kept byte-identical between
 * requests, so OpenRouter's providers can serve that long prefix from their
 * cache. It is rebuilt after a playlist is created or switched in or out, and
 * once forty songs have been added since — playlists that filled up
 * noticeably should be described as they are now.
 */
export function noteAdds(count: number): void {
	addsSinceCatalog += count;
	if (addsSinceCatalog >= 40) invalidateCatalog();
}

export function invalidateCatalog(): void {
	addsSinceCatalog = 0;
	catalogVersion++;
}

export function currentCatalogVersion(): number {
	return catalogVersion;
}
