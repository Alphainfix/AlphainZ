import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { refreshLocalModelAtom, releaseRemovedProvidersAtom } from '../../../../atoms/models';
import { SettingsGroup, SettingsRow } from '../../../preferences/components/SettingsElements';
import { VENDORS, type Vendor, type KeyPrefName } from '../../../preferences/ModelSettingsSection';
import { OllamaGuide } from '../../../preferences/OllamaGuide';
import { getPref, setPref } from '../../../../../src/utils/prefs';
import { verifyChatProvider } from '../../../../../src/services/llm/verifyKey';
import { catalogueFor } from '../../../../../src/services/llm/providerOverrides';

/** `fetch` bound to its global — see the note in agentConfig. */
const boundFetch = ((url: string, init?: any) => fetch(url, init)) as any;

const storedKey = (keyPref: KeyPrefName): string => String(getPref(keyPref) ?? '').trim();

/**
 * Step ①: one API key is enough to start.
 *
 * A key that was already stored when the step opened renders masked as
 * "Already set ✓" — the upgrade path must acknowledge existing work, not ask
 * for it again — with a Change button for the rare re-key.
 *
 * A key entered here stays in its field while it is typed and is saved when
 * the field loses focus or Enter is pressed; a pasted key is saved and tested
 * at once. Saving on every keystroke would swap the field for "Already set ✓"
 * after the first character and store that character as the key. A step
 * closed while the field still has focus (the window closed from the
 * keyboard) gets no blur, so the field is saved on the way out too. Clearing
 * a saved key gives up the model it had picked, so the first question does
 * not go to a provider this computer no longer has a key for.
 */
const KeyRow: React.FC<{ vendor: Vendor; onTested: (vendor: Vendor, ok: boolean) => void }> = ({ vendor, onTested }) => {
    const [hadKey] = useState(() => storedKey(vendor.keyPref).length > 0);
    const [editing, setEditing] = useState(() => !hadKey);
    const [draft, setDraft] = useState(() => storedKey(vendor.keyPref));
    const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState('');
    const pastedRef = useRef(false);

    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const releaseRemovedProviders = useSetAtom(releaseRemovedProvidersAtom);

    /** Save the field when it holds something other than the stored key; returns what is stored. */
    const commit = useCallback((raw: string): string => {
        const next = raw.trim();
        if (next === storedKey(vendor.keyPref)) return next;
        setPref(vendor.keyPref, next);
        // The model list is derived from the stored keys; a key saved after
        // load has to rebuild it, or the composer keeps saying nothing is
        // configured until Zotero restarts.
        if (next) refreshLocalModel();
        else releaseRemovedProviders(vendor.providers.map((entry) => entry.id));
        return next;
    }, [vendor.keyPref, vendor.providers, refreshLocalModel, releaseRemovedProviders]);

    const runTest = useCallback(async (key: string) => {
        if (!key) return;
        setTest('testing');
        const result = await verifyChatProvider(vendor.providers[0].id, key, boundFetch, {});
        setTest(result.ok ? 'ok' : 'error');
        setTestMessage(result.message ?? '');
        onTested(vendor, result.ok);
    }, [vendor, onTested]);

    const showsInput = editing || !hadKey;

    const leaving = useRef({ commit, draft, showsInput });
    leaving.current = { commit, draft, showsInput };
    useEffect(() => () => {
        const { commit: save, draft: typed, showsInput: open } = leaving.current;
        if (open) save(typed);
    }, []);

    return (
        <SettingsRow
            stacked
            title={vendor.label}
            description={
                test === 'error' && testMessage
                    ? <span className="font-color-red" role="alert">{testMessage}</span>
                    : test === 'ok'
                        ? <span className="font-color-green" role="status">Key works — saved.</span>
                        // One line here; the provider's full note on hover.
                        : <span title={vendor.note}>{vendor.summary ?? vendor.note ?? ''}</span>
            }
            control={
                !showsInput ? (
                    <div className="display-flex flex-row items-center gap-2 flex-wrap">
                        <span className="text-sm font-color-green">Already set ✓</span>
                        <Button variant="outline" onClick={() => setEditing(true)}>Change</Button>
                        <Button variant="outline" onClick={() => void runTest(storedKey(vendor.keyPref))} loading={test === 'testing'}>
                            Test
                        </Button>
                    </div>
                ) : (
                    <div className="display-flex flex-row items-center gap-2 w-full">
                        <input
                            type="password"
                            className="flex-1 min-w-0 py-1 px-2 preference-input text-sm"
                            placeholder={`${vendor.label} API key`}
                            value={draft}
                            onPaste={() => {
                                // The paste arrives as the next change; a paste
                                // that changes nothing must not leave the flag set.
                                pastedRef.current = true;
                                setTimeout(() => { pastedRef.current = false; }, 0);
                            }}
                            onChange={(e) => {
                                setDraft(e.target.value);
                                setTest('idle');
                                if (pastedRef.current) {
                                    pastedRef.current = false;
                                    void runTest(commit(e.target.value));
                                }
                            }}
                            onBlur={() => commit(draft)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commit(draft);
                            }}
                            aria-label={`${vendor.label} API key`}
                        />
                        {draft.trim() && (
                            <Button variant="outline" onClick={() => void runTest(commit(draft))} loading={test === 'testing'}>
                                Test
                            </Button>
                        )}
                    </div>
                )
            }
        />
    );
};

const ApiKeysStep: React.FC = () => {
    const [showLocal, setShowLocal] = useState(false);
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);

    /*
     * With no model chosen when the step opened, the first key saved picks one
     * (see validateSelectedModelAtom). That may be a key pasted into the wrong
     * row: a pick whose Test failed gives way to the next key that passes, so
     * the first question goes to a provider known to answer.
     */
    const [picking] = useState(() => !String(getPref('llmProvider') ?? '').trim());
    const failedRef = useRef(new Set<string>());
    const onTested = useCallback((vendor: Vendor, ok: boolean) => {
        const id = vendor.providers[0].id;
        if (!ok) {
            failedRef.current.add(id);
            return;
        }
        failedRef.current.delete(id);
        const inUse = String(getPref('llmProvider') ?? '').trim();
        if (!picking || inUse === id || !failedRef.current.has(inUse)) return;
        setPref('llmProvider', id);
        setPref('llmModel', catalogueFor(id)[0]?.id ?? '');
        refreshLocalModel();
    }, [picking, refreshLocalModel]);

    return (
        <>
            <div className="text-base font-color-secondary mb-2">
                One key is enough to start — DeepSeek is the recommended first pick. Keys are
                stored locally in Zotero's preferences and are never synced anywhere.
            </div>
            <SettingsGroup>
                {VENDORS.map((vendor) => <KeyRow key={vendor.id} vendor={vendor} onTested={onTested} />)}
            </SettingsGroup>
            <div className="mt-2 text-sm font-color-secondary">
                No key at all?{' '}
                <a className="text-link cursor-pointer" onClick={() => setShowLocal((v) => !v)}>
                    {showLocal ? 'Hide the local option' : 'Run a model on this computer with Ollama'}
                </a>
            </div>
            {showLocal && (
                <div className="mt-1">
                    <OllamaGuide showChat />
                </div>
            )}
        </>
    );
};

export default ApiKeysStep;
