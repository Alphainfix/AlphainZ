/**
 * What this conversation has cost, in tokens, next to the model that decides it.
 *
 * Beaver showed a credit balance here because it billed for the run. There is no
 * balance to show when the request goes straight to the user's own key — but
 * there is still a meter running, and it is their meter. The honest local
 * equivalent is the count the provider itself reported.
 *
 * Tokens rather than money on purpose: turning tokens into a figure in dollars
 * needs a per-model price table, and a stale price table is a wrong number
 * stated confidently. The token count is what the provider actually billed.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';

import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';

/** `1234` → `1.2k`. Exact below a thousand, where the digits still mean something. */
export function formatTokens(total: number): string {
    if (total < 1000) return String(total);
    if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`;
    return `${(total / 1_000_000).toFixed(1)}M`;
}

interface Totals {
    input: number;
    output: number;
    cached: number;
    runs: number;
}

/** Sum what every run in the thread reported. */
export function sumUsage(runs: AgentRun[]): Totals {
    const totals: Totals = { input: 0, output: 0, cached: 0, runs: 0 };
    for (const run of runs) {
        const usage = run.total_usage;
        if (!usage) continue;
        totals.input += usage.input_tokens ?? 0;
        totals.output += usage.output_tokens ?? 0;
        totals.cached += usage.cache_read_tokens ?? 0;
        totals.runs += 1;
    }
    return totals;
}

const RunUsageChip: React.FC = () => {
    const runs = useAtomValue(allRunsAtom);
    const totals = sumUsage(runs);
    /*
     * Details on click, not on hover. The pointer crosses this corner on its
     * way to Send and to the model picker, and a card that pops up over the
     * composer at every pass reads as an obstacle, not information.
     */
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return;
        const onPointerDown = (e: Event) => {
            if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
            setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        doc.addEventListener('pointerdown', onPointerDown, true);
        doc.addEventListener('keydown', onKeyDown, true);
        return () => {
            doc.removeEventListener('pointerdown', onPointerDown, true);
            doc.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    // Nothing to say before the first answer, and saying "0 tokens" would read
    // as a claim that the last run was free.
    if (totals.runs === 0) return null;

    const total = totals.input + totals.output;
    const detail = [
        `${totals.input.toLocaleString()} in · ${totals.output.toLocaleString()} out`,
        totals.cached > 0 ? `${totals.cached.toLocaleString()} of the input came from cache` : null,
        `across ${totals.runs} ${totals.runs === 1 ? 'message' : 'messages'} in this chat`,
        'Counted by the provider, billed to your own key.',
    ]
        .filter(Boolean)
        .join('\n');

    return (
        <span ref={rootRef} className="ml-2 flex-shrink-0" style={{ position: 'relative', display: 'inline-block' }}>
            <span
                role="button"
                tabIndex={0}
                className="text-sm font-color-tertiary whitespace-nowrap cursor-pointer"
                aria-label={`${total} tokens used in this chat — click for the breakdown`}
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
            >
                {`${formatTokens(total)} tokens`}
            </span>
            {open && (
                <span
                    className="bg-quaternary rounded-md shadow-md border-popup block px-2 py-1 z-100000"
                    style={{
                        position: 'absolute',
                        bottom: 'calc(100% + 8px)',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: '250px',
                        whiteSpace: 'pre-line',
                    }}
                    role="dialog"
                >
                    {detail}
                </span>
            )}
        </span>
    );
};

export default RunUsageChip;
