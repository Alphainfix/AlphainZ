/**
 * Where this plugin keeps its files inside the Zotero profile.
 *
 * Named after the plugin rather than inherited from Beaver, because both write
 * here: the document cache and the key store shared one `beaver/` directory, so
 * two installed plugins would have been reading and overwriting each other's
 * cache entries. The database had the same problem and was renamed for the same
 * reason.
 *
 * Nothing is migrated. Both directories hold derived data — an extraction cache
 * that rebuilds on demand, and a key store whose keys now live in preferences —
 * so a fresh start costs one re-extraction rather than anything the user would
 * miss.
 */

import { config } from '../../package.json';

/** Directory name under the Zotero profile, e.g. `alphainz`. */
export const PLUGIN_DIR_NAME = config.addonRef;
