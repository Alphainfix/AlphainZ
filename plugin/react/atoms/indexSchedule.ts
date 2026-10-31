/**
 * Whether a full-text sweep is due: scheduled — after a library change, a
 * provider change or at startup — but not yet through its passages.
 *
 * Set by the sweep in useFulltextIndex and read by the page-image run, which
 * waits while it is set: a paper just added is read for its words before its
 * pages, even in the seconds before its passage run has started.
 */
import { atom } from 'jotai';

export const fulltextSweepDueAtom = atom(false);
