/**
 * Talking to a local Ollama: is it running, what does it have, and pulling a
 * model from inside Zotero so nobody has to open a terminal.
 *
 * Pulling uses Ollama's own `/api/pull`, which streams progress lines. Models
 * come from the public library and need no account — an Ollama sign-in is only
 * for its cloud models and for publishing your own.
 */

export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

/** The models the guide offers, with why each one. Sizes are what Ollama reports. */
export const OLLAMA_MODELS = [
    {
        // The exact quantization, not the `440m` alias: the alias may resolve
        // to another build on another platform, and every build embeds a
        // little differently.
        name: 'embeddinggemma-2:440m-q8_0-text-vision',
        role: 'embedding' as const,
        size: '671 MB',
        purpose: 'EmbeddingGemma 2, Google’s open embedding model: indexes your library for topic search, '
            + 'in Chinese, English and a hundred other languages. Needs Ollama 0.40 or later.',
        minOllama: '0.40.0',
    },
    {
        name: 'qwen2.5:7b',
        role: 'chat' as const,
        size: '4.7 GB',
        purpose: 'A chat model that supports tool calling; good in Chinese. Needs about 8 GB of memory.',
    },
] as const;

export type OllamaModelName = (typeof OLLAMA_MODELS)[number]['name'];

/** The server root: no trailing slash, and never the `/v1` OpenAI-compatible suffix. */
export function normalizeOllamaBase(raw?: string | null): string {
    const trimmed = (raw ?? '').trim() || OLLAMA_DEFAULT_BASE;
    return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Names of models that only turn text into vectors. They cannot chat: Ollama
 * answers a chat request to one with "does not support chat". Used when Ollama
 * has not said what a model can do (an older Ollama, or a list stored before
 * it was asked): the embedding model this plugin offers, and the families
 * other apps commonly install (nomic-embed-text, mxbai-embed-large,
 * snowflake-arctic-embed, granite-embedding, all-minilm, bge-large…).
 */
const EMBEDDING_NAME_PATTERNS: readonly RegExp[] = [/embed/, /^bge-/, /minilm/, /^paraphrase-multilingual/];

/** A tag's model name: lower case, without its `:tag` and any registry or namespace path. */
function baseModelName(tag: string): string {
    const withoutTag = tag.trim().toLowerCase().replace(/:[^/:]*$/, '');
    return withoutTag.slice(withoutTag.lastIndexOf('/') + 1);
}

/**
 * Whether an installed Ollama model only embeds text.
 *
 * `capabilities` is what Ollama's `/api/show` reported for the model, when it
 * was asked: `embedding` without `completion` settles it. Without an answer
 * the name decides.
 */
export function isOllamaEmbeddingModel(tag: string, capabilities?: readonly string[]): boolean {
    if (capabilities && capabilities.length > 0) {
        return capabilities.includes('embedding') && !capabilities.includes('completion');
    }
    const base = baseModelName(tag);
    if (OLLAMA_MODELS.some((m) => m.role === 'embedding' && baseModelName(m.name) === base)) return true;
    return EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(base));
}

/** The installed models that can chat: the ones the model picker may offer. */
export function ollamaChatModels(
    installed: readonly string[],
    capabilities: Readonly<Record<string, readonly string[]>> = {},
): string[] {
    return installed.filter((tag) => !isOllamaEmbeddingModel(tag, capabilities[tag]));
}

/**
 * Whether an Ollama version is at least `min`: dotted numbers compared in
 * order, a pre-release suffix ignored. An unreadable version passes, since
 * refusing a model on a guess would be worse than letting the pull say no.
 */
export function ollamaVersionAtLeast(version: string | null | undefined, min: string): boolean {
    const parse = (text: string) => text.trim().replace(/^v/, '').split(/[-+]/)[0].split('.').map((part) => Number(part));
    const have = parse(version ?? '');
    const want = parse(min);
    if (have.length === 0 || have.some((n) => !Number.isFinite(n))) return true;
    for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
        const a = have[i] ?? 0;
        const b = want[i] ?? 0;
        if (a !== b) return a > b;
    }
    return true;
}

/** Ollama lists tags like `bge-m3:latest`; the guide asks for `bge-m3`. */
export function isModelInstalled(installed: readonly string[], name: string): boolean {
    const wanted = name.includes(':') ? name : `${name}:latest`;
    return installed.some((tag) => tag === wanted || tag === name || (!name.includes(':') && tag.startsWith(`${name}:`)));
}

export interface OllamaStatus {
    running: boolean;
    version: string | null;
    /** Every installed model, chat and embedding alike. */
    models: string[];
    /**
     * What Ollama said each model can do (`completion`, `embedding`, `vision`,
     * `tools`…), for the models it described. Absent when it described none,
     * which is what an Ollama too old to report capabilities does.
     */
    capabilities?: Record<string, string[]>;
    error?: string;
}

type FetchImpl = (url: string, init?: any) => Promise<any>;

/**
 * Ask `/api/show` what each model can do. A model Ollama does not describe is
 * left out, and the name decides for it (`isOllamaEmbeddingModel`).
 */
async function describeModels(
    root: string,
    models: readonly string[],
    fetchImpl: FetchImpl,
    signal: AbortSignal,
): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    await Promise.all(models.map(async (name) => {
        try {
            const response = await fetchImpl(`${root}/api/show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: name }),
                signal,
            });
            if (!response?.ok) return;
            const capabilities = (await response.json())?.capabilities;
            if (Array.isArray(capabilities) && capabilities.length > 0) out[name] = capabilities.map(String);
        } catch {
            // Not described; the name decides.
        }
    }));
    return out;
}

/** `/api/version` and `/api/tags`, then `/api/show` for what each model can do. */
export async function ollamaStatus(
    base: string,
    fetchImpl: FetchImpl = (url, init) => fetch(url, init),
    timeoutMs = 4000,
): Promise<OllamaStatus> {
    const root = normalizeOllamaBase(base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const versionResponse = await fetchImpl(`${root}/api/version`, { signal: controller.signal });
        if (!versionResponse.ok) throw new Error(`Ollama answered ${versionResponse.status}`);
        const version = String((await versionResponse.json())?.version ?? '');
        const tagsResponse = await fetchImpl(`${root}/api/tags`, { signal: controller.signal });
        const tags = tagsResponse.ok ? await tagsResponse.json() : { models: [] };
        const models = (Array.isArray(tags?.models) ? tags.models : [])
            .map((m: any) => String(m?.name ?? m?.model ?? ''))
            .filter((n: string) => n.length > 0);
        const capabilities = await describeModels(root, models, fetchImpl, controller.signal);
        return {
            running: true,
            version: version || null,
            models,
            ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        };
    } catch (error) {
        return {
            running: false,
            version: null,
            models: [],
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

export interface PullProgress {
    /** Ollama's own status text: "pulling manifest", "pulling 8a…", "verifying", "success". */
    status: string;
    completed: number | null;
    total: number | null;
    /** 0–100 while a layer downloads, null when the line carries no sizes. */
    percent: number | null;
    done: boolean;
}

/** One NDJSON line of `/api/pull` → progress; throws on an error line. */
export function parsePullLine(line: string): PullProgress | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: any;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (parsed?.error) throw new Error(String(parsed.error));
    const status = String(parsed?.status ?? '');
    const total = typeof parsed?.total === 'number' ? parsed.total : null;
    const completed = typeof parsed?.completed === 'number' ? parsed.completed : null;
    const percent = total && total > 0 && completed !== null
        ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
        : null;
    return { status, completed, total, percent, done: status === 'success' };
}

/** Why a pull that ended without Ollama's `success` line is not a finished download. */
export const PULL_INTERRUPTED_MESSAGE = 'The download stopped before it finished.';

/**
 * Pull `name` into the local Ollama, reporting progress as it streams.
 * Resolves when Ollama reports success; rejects on an Ollama error, when the
 * server cannot be reached, and when the stream ends without a success line.
 */
export async function pullOllamaModel(
    base: string,
    name: string,
    fetchImpl: FetchImpl = (url, init) => fetch(url, init),
    onProgress?: (progress: PullProgress) => void,
    signal?: AbortSignal,
): Promise<void> {
    const root = normalizeOllamaBase(base);
    const response = await fetchImpl(`${root}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal,
    });
    if (!response.ok) {
        let detail = '';
        try { detail = String((await response.json())?.error ?? ''); } catch { /* no body */ }
        throw new Error(detail || `Ollama answered ${response.status}`);
    }
    let succeeded = false;
    const handle = (line: string) => {
        const progress = parsePullLine(line);
        if (progress) onProgress?.(progress);
        if (progress?.done) succeeded = true;
    };
    const reader = response.body?.getReader?.();
    if (!reader) {
        // No streaming body: the whole response arrives at once when done.
        for (const line of String(await response.text()).split('\n')) handle(line);
    } else {
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) handle(line);
            if (done) break;
        }
        if (buffer.trim()) handle(buffer);
    }
    if (!succeeded) throw new Error(PULL_INTERRUPTED_MESSAGE);
}

// ---------------------------------------------------------------------------
// Downloads that outlive the screen that started them
// ---------------------------------------------------------------------------

export interface OllamaPullState {
    status: 'pulling' | 'done' | 'error' | 'cancelled';
    percent: number | null;
    message?: string;
}

/*
 * One entry per server and model, kept at module level rather than in the
 * component that shows it. Ollama runs a pull for as long as the request that
 * asked for it stays open, so a pull owned by a component would end whenever
 * the component went away: Next in the wizard, Done on the Ollama card,
 * another Settings tab. Here it runs until it finishes, fails, or Cancel is
 * pressed, and any guide that mounts meanwhile shows its progress.
 */
const pulls = new Map<string, { state: OllamaPullState; controller: AbortController | null }>();
const pullListeners = new Set<() => void>();
let pullsVersion = 0;

const pullKey = (base: string, name: string) => `${normalizeOllamaBase(base)} ${name}`;

function setPull(key: string, state: OllamaPullState, controller: AbortController | null): void {
    pulls.set(key, { state, controller });
    pullsVersion += 1;
    for (const listener of [...pullListeners]) listener();
}

function formatPullBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
}

/** Called whenever any pull's state changes; returns the unsubscribe. */
export function subscribeOllamaPulls(listener: () => void): () => void {
    pullListeners.add(listener);
    return () => { pullListeners.delete(listener); };
}

/** Changes whenever any pull's state does: a snapshot for `useSyncExternalStore`. */
export function ollamaPullsVersion(): number {
    return pullsVersion;
}

/** The download of `name` from this server, if one was started this session. */
export function ollamaPullState(base: string, name: string): OllamaPullState | undefined {
    return pulls.get(pullKey(base, name))?.state;
}

/**
 * Start downloading `name`, unless it is already downloading. `onFinished`
 * runs once the pull ends, however it ends, whether or not anything is still
 * showing it.
 */
export function startOllamaPull(
    base: string,
    name: string,
    options: { fetchImpl?: FetchImpl; onFinished?: (status: OllamaPullState['status']) => void } = {},
): void {
    const key = pullKey(base, name);
    if (pulls.get(key)?.state.status === 'pulling') return;
    const controller = new AbortController();
    setPull(key, { status: 'pulling', percent: null, message: 'Starting…' }, controller);
    void (async () => {
        let status: OllamaPullState['status'];
        try {
            await pullOllamaModel(base, name, options.fetchImpl, (progress) => {
                setPull(key, {
                    status: 'pulling',
                    percent: progress.percent,
                    message: progress.total && progress.completed !== null
                        ? `${formatPullBytes(progress.completed)} of ${formatPullBytes(progress.total)}`
                        : progress.status,
                }, controller);
            }, controller.signal);
            status = 'done';
            setPull(key, { status, percent: 100 }, null);
        } catch (error) {
            // Ollama keeps the layers it already has, so the next Get resumes.
            status = controller.signal.aborted ? 'cancelled' : 'error';
            const reason = (error instanceof Error ? error.message : String(error)).trim().replace(/\.$/, '');
            setPull(key, {
                status,
                percent: null,
                message: status === 'cancelled'
                    ? 'Download cancelled. What was already downloaded is kept; Resume picks up from there.'
                    : `Download interrupted (${reason}). Resume picks up where it stopped.`,
            }, null);
        }
        try {
            options.onFinished?.(status);
        } catch {
            // A follow-up that fails leaves the pull's own outcome standing.
        }
    })();
}

/** Stop a download in flight. Ollama keeps what it already has. */
export function cancelOllamaPull(base: string, name: string): void {
    pulls.get(pullKey(base, name))?.controller?.abort();
}

/** Test seam: forget every download. */
export function resetOllamaPulls(): void {
    for (const { controller } of pulls.values()) controller?.abort();
    pulls.clear();
    pullsVersion += 1;
}

// ---------------------------------------------------------------------------
// What Ollama has, as last read
// ---------------------------------------------------------------------------

type StatusListener = (base: string, status: OllamaStatus) => void;
const statusListeners = new Set<StatusListener>();

/**
 * Hear about every fresh read of an Ollama's status (a guide's check, Detect
 * models, the end of a download), with the server it describes.
 */
export function onOllamaStatus(listener: StatusListener): () => void {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); };
}

/** Tell every listener what an Ollama now has. */
export function publishOllamaStatus(base: string, status: OllamaStatus): void {
    const root = normalizeOllamaBase(base);
    for (const listener of [...statusListeners]) {
        try {
            listener(root, status);
        } catch {
            // One listener's failure must not keep the news from the rest.
        }
    }
}

/** `ollama pull <name>` — for people who would rather use the terminal. */
export function pullCommand(name: string): string {
    return `ollama pull ${name}`;
}
