/**
 * Ask an OpenAI-compatible endpoint which models it serves.
 *
 * `GET /models` is the one listing call every such endpoint shares. It is how
 * the catalogue editor offers "fetch available models" instead of asking the
 * user to type ids from a vendor's documentation — and how a model released
 * after this plugin was built gets into the list without a new build.
 */

import type { FetchLike } from './openAICompatible';
import type { AuthStyle } from './types';

export interface ListModelsTarget {
    baseUrl: string;
    apiKey: string;
    authStyle?: AuthStyle;
}

const LIST_TIMEOUT_MS = 15_000;

/** Model ids, sorted; throws with a readable message when the call fails. */
export async function fetchModelIds(target: ListModelsTarget, fetchImpl: FetchLike): Promise<string[]> {
    const base = target.baseUrl.replace(/\/+$/, '');
    if (!base) throw new Error('Enter the base URL first.');
    const auth: Record<string, string> = !target.apiKey
        ? {}
        : (target.authStyle ?? 'bearer') === 'x-api-key'
            ? { 'X-Api-Key': target.apiKey }
            : { Authorization: `Bearer ${target.apiKey}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(`${base}/models`, { method: 'GET', headers: auth, signal: controller.signal });
        const status = Number(response?.status ?? 0);
        let body: any = null;
        try {
            body = JSON.parse(await response.text());
        } catch {
            body = null;
        }
        if (status < 200 || status >= 300) {
            const message = body?.error?.message ?? body?.message ?? `HTTP ${status}`;
            throw new Error(`The endpoint answered ${String(message).slice(0, 160)}`);
        }
        // OpenAI shape: { data: [{ id }] }. Ollama's own listing is not used
        // here — its OpenAI-compatible root answers this shape too.
        const rows: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
        const ids = rows
            .map((row: any) => (typeof row === 'string' ? row : String(row?.id ?? row?.name ?? '')))
            .map((id) => id.trim())
            .filter(Boolean);
        return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`No answer from ${base} within ${LIST_TIMEOUT_MS / 1000} s.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
