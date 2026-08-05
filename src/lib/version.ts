/**
 * The single build version, shared by the MCP server handshake and the
 * User-Agent this app presents to third-party APIs.
 *
 * MusicBrainz *requires* an application name and version in the User-Agent and
 * blocks generic ones, so this string is load-bearing rather than cosmetic.
 */
export const APP_NAME = 'spotidata';
export const APP_VERSION = '0.1.3';
