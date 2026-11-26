import { logger } from '@beaver/agent-core/platform/logger';
import { store } from '../../store';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';
import { msg, t } from '../../../src/utils/i18n';

/** Surface a transient warning when an external file can't be opened here. */
function notifyExternalFileUnavailable(): void {
    try {
        store.set(addPopupMessageAtom, {
            id: 'external-file-unavailable',
            type: 'warning',
            title: t('File Not Available'),
            text: t('This file is not available on this computer. It was removed or attached on another device.'),
        });
    } catch (e) {
        logger(`notifyExternalFileUnavailable: failed to surface popup: ${e}`, 2);
    }
}

/**
 * A navigation target (item, collection, annotation, saved action) that was
 * rendered from persisted run history but no longer exists on this computer.
 */
export type UnavailableReferenceKind = 'item' | 'collection' | 'annotation' | 'action';
export type UnavailableReferenceCause = 'missing' | 'library_unavailable';

/** English; shown through `t`. */
const UNAVAILABLE_REFERENCE_COPY: Record<UnavailableReferenceKind, { title: string; text: string }> = {
    item: {
        title: msg('Item Not Available'),
        text: msg('This item is no longer in your Zotero library. It may have been deleted.'),
    },
    collection: {
        title: msg('Collection Not Available'),
        text: msg('This collection is no longer in your Zotero library. It may have been deleted.'),
    },
    annotation: {
        title: msg('Annotation Not Available'),
        text: msg('This annotation is no longer in your Zotero library. It may have been deleted.'),
    },
    action: {
        title: msg('Action Not Found'),
        text: msg('This action is not available on this computer. It may have been deleted or created on another device.'),
    },
};

/** English; shown through `t`. */
const LIBRARY_UNAVAILABLE_COPY: Record<Exclude<UnavailableReferenceKind, 'action'>, { title: string; text: string }> = {
    item: {
        title: msg('Item Not Available'),
        text: msg("This item is in a library that isn't available on this computer. It may be a group library you haven't joined on this device."),
    },
    collection: {
        title: msg('Collection Not Available'),
        text: msg("This collection is in a library that isn't available on this computer. It may be a group library you haven't joined on this device."),
    },
    annotation: {
        title: msg('Annotation Not Available'),
        text: msg("This annotation is in a library that isn't available on this computer. It may be a group library you haven't joined on this device."),
    },
};

/**
 * Surface a transient warning when a reveal/open target no longer exists.
 *
 * Request chips and other history-rendered surfaces are built from persisted
 * data, so their targets can be deleted between when a run was saved and when
 * the user clicks. Mirrors {@link notifyExternalFileUnavailable}.
 */
export function notifyReferenceUnavailable(
    kind: UnavailableReferenceKind,
    cause: UnavailableReferenceCause = 'missing',
): void {
    const copy = cause === 'library_unavailable' && kind !== 'action'
        ? LIBRARY_UNAVAILABLE_COPY[kind]
        : UNAVAILABLE_REFERENCE_COPY[kind];
    try {
        store.set(addPopupMessageAtom, {
            id: `reference-unavailable-${kind}-${cause}`,
            type: 'warning',
            title: t(copy.title),
            text: t(copy.text),
        });
    } catch (e) {
        logger(`notifyReferenceUnavailable: failed to surface popup: ${e}`, 2);
    }
}

/**
 * Open a locally stored external-file copy by its ext key.
 *
 * Warns the user when the file was attached on another computer (no local copy
 * on this machine). Shared by citation activation and the cited-sources list.
 */
export async function launchExternalFile(extKey: string): Promise<void> {
    try {
        const record = await Zotero.AlphainZ?.db?.getExternalFileByKey(extKey);
        const path = record?.storedPath ?? null;
        if (path && (await IOUtils.exists(path).catch(() => false))) {
            Zotero.launchFile(path);
        } else {
            logger(`launchExternalFile: ext-${extKey} has no local copy`);
            notifyExternalFileUnavailable();
        }
    } catch (e) {
        logger(`launchExternalFile: failed to open external file: ${e}`, 2);
        notifyExternalFileUnavailable();
    }
}
