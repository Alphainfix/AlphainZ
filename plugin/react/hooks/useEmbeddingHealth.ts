/**
 * The last embedding failure for the model in use, kept current while shown.
 *
 * The failure is recorded wherever an embedding request ends — a search tool,
 * an indexer — so the preference is what changes; watching it is how Settings
 * learns of a failure, or of the success that clears it, without being reopened.
 */

import { useEffect, useState } from 'react';

import { currentEmbeddingModelId } from '../../src/services/llm/agentConfig';
import { readEmbeddingHealth, type EmbeddingHealth } from '@beaver/agent-llm/embeddingHealth';
import pkg from '../../package.json';

const WATCHED = ['embeddingHealth', 'embeddingProvider'];

export function useEmbeddingHealth(): EmbeddingHealth | null {
    const read = () => readEmbeddingHealth(currentEmbeddingModelId());
    const [health, setHealth] = useState<EmbeddingHealth | null>(read);
    useEffect(() => {
        const update = () => setHealth(read());
        const symbols = WATCHED.map((key) =>
            Zotero.Prefs.registerObserver(`${pkg.config.prefsPrefix}.${key}`, update, true));
        update();
        return () => symbols.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol));
    }, []);
    return health;
}

/** "14:05", or "Oct 22, 14:05" for an earlier day: when a failure happened. */
export function failureTimeText(at: number, now: number = Date.now()): string {
    const when = new Date(at);
    const time = `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
    return new Date(now).toDateString() === when.toDateString()
        ? time
        : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
