import type { SpotifyImage } from './types.ts';

/** The image closest to 300 px wide, which is what a list row needs. */
export function pickImage(images: SpotifyImage[] | null | undefined): string | undefined {
	if (!images?.length) return undefined;
	const width = (i: SpotifyImage) => i.width ?? 300;
	return [...images].sort((a, b) => Math.abs(width(a) - 300) - Math.abs(width(b) - 300))[0]?.url;
}
