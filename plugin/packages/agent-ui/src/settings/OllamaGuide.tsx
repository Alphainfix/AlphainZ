import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Button from '../primitives/Button';
import { t, tn, tr } from '../i18n';
import { ProgressBar } from './ProgressBar';
import { useSettingsHost, type OllamaStatus } from './host';

export interface OllamaGuideProps {
    /** Server address as typed in the settings; defaults to the local one. */
    base?: string;
    /** Offer the chat model. */
    showChat?: boolean;
    /** Offer the embedding model. */
    showEmbedding?: boolean;
    /** Fewer words: for the wizard and the embedding section. */
    compact?: boolean;
    /** Called with the installed model names whenever they are (re)read. */
    onModelsChanged?: (models: string[]) => void;
}

/**
 * Everything a person needs to run models locally, without a terminal.
 *
 * Whether Ollama is running, the two models this plugin can use and a button
 * that downloads each through Ollama's own API with progress, the command for
 * anyone who prefers to type it, and the one setting chat models need. No
 * account is involved at any step: Ollama's public library serves models
 * anonymously; a sign-in is only for its cloud models.
 *
 * A download belongs to the client's Ollama service, not to this component:
 * it keeps going when the guide closes (Next in the wizard, Done on the Ollama
 * card, another Settings tab), any guide shows its progress, and only Cancel
 * stops it.
 */
export const OllamaGuide: React.FC<OllamaGuideProps> = ({
    base,
    showChat = false,
    showEmbedding = false,
    compact = false,
    onModelsChanged,
}) => {
    const host = useSettingsHost();
    const ollama = host.ollama;
    const root = ollama.normalizeBase(base);
    const [status, setStatus] = useState<OllamaStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    // Re-render on every change to any download's progress.
    useSyncExternalStore(ollama.subscribePulls, ollama.pullsVersion);
    const onModelsChangedRef = useRef(onModelsChanged);
    onModelsChangedRef.current = onModelsChanged;

    // Every fresh read of this server — this guide's check, another guide's,
    // Detect models, the end of a download — updates what is shown here.
    useEffect(() => ollama.onStatus((server, next) => {
        if (server !== root) return;
        setStatus(next);
        if (next.running) onModelsChangedRef.current?.(next.models);
    }), [root]);

    const check = useCallback(async () => {
        setChecking(true);
        try {
            await ollama.refreshStatus(root);
        } finally {
            setChecking(false);
        }
    }, [root]);

    useEffect(() => {
        void check();
    }, [check]);

    const pull = useCallback((name: string) => {
        ollama.startPull(root, name, {
            fetchImpl: host.fetch,
            // Runs even when no guide is open any more, so a model that
            // finished downloading reaches the model picker regardless.
            onFinished: () => { void ollama.refreshStatus(root); },
        });
    }, [root]);

    const copy = useCallback(async (text: string) => {
        const ok = await host.copyText(text);
        setCopied(ok ? text : null);
        if (ok) setTimeout(() => setCopied((current) => (current === text ? null : current)), 2000);
    }, []);

    const models = ollama.models.filter((m) => (m.role === 'chat' ? showChat : showEmbedding));
    const running = status?.running === true;

    return (
        <div className="display-flex flex-col gap-2">
            {/* 1. Is Ollama there? */}
            <div className="display-flex flex-row items-center gap-2 flex-wrap">
                <span className={`text-sm ${running ? 'font-color-green' : 'font-color-secondary'}`}>
                    {status === null
                        ? t('Checking Ollama…')
                        : running
                            ? tn(status.models.length, 'Ollama {version} is running · {count} model installed', 'Ollama {version} is running · {count} models installed', { version: status.version ?? '' })
                            : t('Ollama is not running on this computer.')}
                </span>
                <Button variant="ghost-secondary" style={{ padding: '2px 6px' }} onClick={() => void check()} disabled={checking}>
                    {t('Check again')}
                </Button>
                {!running && status !== null && (
                    <Button
                        variant="outline"
                        style={{ padding: '2px 6px' }}
                        onClick={() => host.openUrl('https://ollama.com/download')}
                    >
                        {t('Install Ollama')}
                    </Button>
                )}
            </div>
            {!running && status !== null && (
                <div className="text-sm font-color-tertiary">
                    {t('Install it from ollama.com, open the app once, and it keeps running in the background (menu bar / tray) — including after a restart. No account is needed; models download anonymously from Ollama’s library.')}
                </div>
            )}

            {/* 2. Models */}
            {models.map((model) => {
                const installed = running && ollama.isModelInstalled(status?.models ?? [], model.name);
                const pullState = ollama.pullState(root, model.name);
                const pulling = pullState?.status === 'pulling';
                const stopped = !installed && (pullState?.status === 'error' || pullState?.status === 'cancelled');
                const command = ollama.pullCommand(model.name);
                const minimum = model.minOllama;
                const tooOld = running && !installed && minimum !== undefined
                    && !ollama.versionAtLeast(status?.version, minimum);
                return (
                    <div key={model.name} className="display-flex flex-col gap-1 p-2 rounded-md bg-quinary">
                        <div className="display-flex flex-row items-center gap-2 flex-wrap">
                            <code className="text-sm">{model.name}</code>
                            <span className="text-sm font-color-tertiary">{model.size}</span>
                            <div className="flex-1" />
                            {installed ? (
                                <span className="text-sm font-color-green">{t('Installed ✓')}</span>
                            ) : pulling ? (
                                <Button
                                    variant="ghost-secondary"
                                    style={{ padding: '2px 6px' }}
                                    onClick={() => ollama.cancelPull(root, model.name)}
                                    ariaLabel={t('Cancel downloading {name}', { name: model.name })}
                                >
                                    {t('Cancel')}
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    style={{ padding: '2px 6px' }}
                                    onClick={() => pull(model.name)}
                                    disabled={!running || tooOld}
                                    title={!running
                                        ? t('Start Ollama first')
                                        : tooOld
                                            ? t('Needs Ollama {minimum} or later', { minimum: minimum ?? '' })
                                            : t('Download {name} through Ollama', { name: model.name })}
                                >
                                    {stopped ? t('Resume download') : t('Get it')}
                                </Button>
                            )}
                        </div>
                        {tooOld && (
                            <div className="display-flex flex-row items-center gap-2 flex-wrap text-sm font-color-yellow" role="status">
                                <span>
                                    {t('This model needs Ollama {minimum} or later; this one is {version}.', { minimum: minimum ?? '', version: status?.version ?? '' })}{' '}
                                    {t('Update Ollama (its menu: Check for Updates, or download it again), then Check again.')}
                                </span>
                                <Button
                                    variant="outline"
                                    style={{ padding: '2px 6px' }}
                                    onClick={() => host.openUrl('https://ollama.com/download')}
                                >
                                    {t('Update Ollama')}
                                </Button>
                            </div>
                        )}
                        {!compact && <div className="text-sm font-color-secondary">{t(model.purpose)}</div>}
                        {pulling && (
                            <>
                                <ProgressBar progress={pullState?.percent ?? 0} />
                                <div className="text-sm font-color-tertiary">{pullState?.message}</div>
                            </>
                        )}
                        {stopped && pullState?.message && (
                            <div
                                className={`text-sm ${pullState.status === 'error' ? 'font-color-error' : 'font-color-tertiary'}`}
                                role={pullState.status === 'error' ? 'alert' : undefined}
                            >
                                {pullState.message}
                            </div>
                        )}
                        {!installed && !pulling && (
                            <div className="display-flex flex-row items-center gap-2 text-sm font-color-tertiary">
                                <span>{t('or in a terminal:')}</span>
                                <code>{command}</code>
                                <Button variant="ghost-secondary" style={{ padding: '1px 5px' }} onClick={() => void copy(command)}>
                                    {copied === command ? t('Copied') : t('Copy')}
                                </Button>
                            </div>
                        )}
                    </div>
                );
            })}

            {/* 3. What chat models need */}
            {showChat && !compact && (
                <div className="text-sm font-color-tertiary">
                    {tr('Chat models need a larger context than Ollama’s default: set “Context length” to 32k in the Ollama app’s settings, or run {command} {copy} and reopen Ollama. Installed chat models then appear in the model list as “Ollama (local) · …”. They are sent text only; one that reads images can be marked “Reads figures” on the Ollama card under Settings → Model → Providers.', {
                        command: <code>launchctl setenv OLLAMA_CONTEXT_LENGTH 32768</code>,
                        copy: (
                            <Button variant="ghost-secondary" style={{ padding: '1px 5px' }} onClick={() => void copy('launchctl setenv OLLAMA_CONTEXT_LENGTH 32768')}>
                                {copied === 'launchctl setenv OLLAMA_CONTEXT_LENGTH 32768' ? t('Copied') : t('Copy')}
                            </Button>
                        ),
                    })}
                </div>
            )}
        </div>
    );
};

export default OllamaGuide;
