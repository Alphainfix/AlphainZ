/**
 * Ask the user for a folder, and make sure it can actually be written to.
 *
 * Used by the sync-folder setting: the returned path is where conversations
 * and settings will be mirrored, so a read-only or phantom pick (an unmounted
 * network drive, a cloud folder without local presence) must be refused here,
 * where a message helps, rather than surface later as silent write failures.
 */

interface ZoteroFolderPicker {
    init(parent: Window, title: string, mode: number): void;
    show(): Promise<number>;
    file: string;
    modeGetFolder: number;
    returnOK: number;
}

const createFolderPicker = (): ZoteroFolderPicker => {
    const { FilePicker } = ChromeUtils.importESModule(
        'chrome://zotero/content/modules/filePicker.mjs',
    ) as { FilePicker: new () => ZoteroFolderPicker };
    return new FilePicker();
};

export type FolderPickResult =
    | { ok: true; path: string }
    | { ok: false; reason: 'cancelled' | 'unwritable' };

export async function pickFolder(title: string): Promise<FolderPickResult> {
    const fp = createFolderPicker();
    fp.init(Zotero.getMainWindow(), title, fp.modeGetFolder);
    const outcome = await fp.show();
    if (outcome !== fp.returnOK || !fp.file) return { ok: false, reason: 'cancelled' };

    // Prove writability now, with a throwaway file, instead of finding out on
    // the first conversation.
    const probe = PathUtils.join(fp.file, '.alphainz-write-probe');
    try {
        await IOUtils.writeUTF8(probe, 'probe');
        await IOUtils.remove(probe);
    } catch {
        return { ok: false, reason: 'unwritable' };
    }
    return { ok: true, path: fp.file };
}
