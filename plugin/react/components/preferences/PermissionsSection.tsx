import React, { useCallback, useState } from "react";
import {SettingsGroup, SettingsRow, SectionLabel, SectionHeader, SectionDescription} from "./components/SettingsElements";
import DeferredToolPreferenceSetting from "./DeferredToolPreferenceSetting";
import { getPref, setPref } from "../../../src/utils/prefs";


/**
 * A permission row whose answer is fixed: same layout as the editable rows,
 * the value shown where the menu would be, nothing to click.
 */
const FixedPreferenceRow: React.FC<{ label: string; description: string; value: string }> = ({
    label,
    description,
    value,
}) => (
    <div className="display-flex flex-row items-start justify-between gap-4">
        <div className="display-flex flex-col gap-05 flex-1 min-w-0">
            <div className="font-color-primary text-base">{label}</div>
            <div className="font-color-secondary text-sm">{description}</div>
        </div>
        <div
            className="text-sm font-color-secondary px-2"
            style={{ width: '180px', boxSizing: 'border-box', padding: '4px 10px', flexShrink: 0 }}
            aria-label={`${label}: ${value}`}
        >
            {value}
        </div>
    </div>
);

const PermissionsSection: React.FC = () => {

    // --- Atoms: Permissions ---
    // The master switch: while it is off the agent is offered no tool that
    // changes the library, whatever the rules below it say.
    const [allowWrites, setAllowWrites] = useState(() => getPref('allowAgentWrites') === true);
    const [enableSystemNotifications, setEnableSystemNotifications] = useState(() => getPref('enableSystemNotifications'));
    const [enableResponseCompleteNotifications, setEnableResponseCompleteNotifications] = useState(() => getPref('enableResponseCompleteNotifications'));
    const [accessRemoteFiles, setAccessRemoteFiles] = useState(() => getPref('accessRemoteFiles'));

    // --- Handle System Notifications Toggle ---
    const handleEnableSystemNotificationsToggle = useCallback(() => {
        const newValue = !enableSystemNotifications;
        setPref('enableSystemNotifications', newValue);
        setEnableSystemNotifications(newValue);
    }, [enableSystemNotifications]);

    // --- Handle Response Complete Notifications Toggle ---
    const handleEnableResponseCompleteNotificationsToggle = useCallback(() => {
        const newValue = !enableResponseCompleteNotifications;
        setPref('enableResponseCompleteNotifications', newValue);
        setEnableResponseCompleteNotifications(newValue);
    }, [enableResponseCompleteNotifications]);

    // --- Handle Access Remote Files Toggle ---
    const handleAccessRemoteFilesToggle = useCallback(() => {
        const newValue = !accessRemoteFiles;
        setPref('accessRemoteFiles', newValue);
        setAccessRemoteFiles(newValue);
    }, [accessRemoteFiles]);

    const handleAllowWritesToggle = useCallback(() => {
        const newValue = !allowWrites;
        setPref('allowAgentWrites', newValue);
        setAllowWrites(newValue);
    }, [allowWrites]);

    return (
        <>
            <SectionLabel>Writing to your library</SectionLabel>
            <SectionDescription>
                Off by default. Turned on, AlphainZ may change your library: add highlights and sticky
                notes to PDFs; write new notes and edit notes you have, including rewriting one whole;
                correct a paper's title, authors, year and other fields; edit annotations — their
                colour, comment and tags — and delete them; add papers it found in the literature; and
                tag items and file them into collections, creating collections as needed. Each kind
                follows its rule below — out of the box, every change is shown to you first and waits
                for your approval — and anything applied can be undone from its card in the
                conversation.
            </SectionDescription>
            <SettingsGroup>
                <SettingsRow
                    title="Let AlphainZ change your library"
                    description={allowWrites
                        ? 'On. The rules below decide which changes ask first.'
                        : 'Off. AlphainZ can read your library but not change it, and says so when asked to.'}
                    onClick={handleAllowWritesToggle}
                    control={
                        <input
                            type="checkbox"
                            checked={allowWrites}
                            onChange={handleAllowWritesToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>

            <SectionHeader>Library Modifications</SectionHeader>
            <SectionDescription>
                How each kind of change is handled. <b>Always ask</b> shows the change on a card and
                waits for your approval. <b>Always apply</b> makes it without asking — except the
                riskiest ones, noted per row, which ask anyway. <b>Always review later</b> asks nothing
                while the answer is written: the changes wait on their cards, each with its own Apply
                and Reject, and the end of the answer lists them for your review. Adding papers is the
                one thing that always asks. Anything applied can still be undone from the card in the
                conversation.
            </SectionDescription>
            {!allowWrites && (
                <SectionDescription>
                    Writing to your library is off, so none of these apply until you turn it on above.
                </SectionDescription>
            )}
            {/* Greyed, not locked, while writing is off: the rules can be set
                before it is turned on. */}
            <div
                className={allowWrites ? undefined : 'opacity-60'}
                data-writes-off={allowWrites ? undefined : 'true'}
            >
            <SettingsGroup>
                {/*
                  * One row per thing the agent can actually do — and every one
                  * of these is a tool it is actually offered.
                  *
                  * Three rows were removed once, when the editing tools were
                  * not offered and their switches controlled nothing. They are
                  * back because the tools are back, with one addition the
                  * hosted build also makes: deleting annotations is its own
                  * row. It shares an action type with recolouring them, and
                  * someone who set annotations to "always apply" to stop being
                  * interrupted by highlights has not agreed to silent
                  * deletions.
                  */}
                <div style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_note"
                        label="Note Creation"
                        description="Writing new Zotero notes, filed under the paper they are about"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="edit_note"
                        label="Note Edits"
                        description="Changing the text of a note that already exists, including rewriting it whole. Under Always apply, a rewrite that would drop or replace much of a longer note still asks."
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_highlight_annotations"
                        label="PDF Annotations"
                        description="Highlights and sticky notes AlphainZ adds to a PDF, and edits to annotations already there — colour, comment, tags. Under Always apply, replacing a comment an annotation already has, or removing all of its tags, still asks. Deleting annotations is the next row."
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="delete_annotations"
                        label="Annotation Deletion"
                        description="Removing annotations from a PDF, whatever PDF Annotations is set to. This one loses your own work — leave it on Always ask."
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="edit_metadata"
                        label="Metadata Edits"
                        description="Correcting an item's title, authors, year, DOI and other fields"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    {/*
                      * Not a standing choice. A paper is a new item, a fetched
                      * PDF and a place in a collection, all on the model's
                      * reading of a search result — the user's word was that
                      * adding papers always needs their yes. Offering "always
                      * apply" here made it look like one setting among equals,
                      * and a stored value from that time is ignored (see
                      * NO_STANDING_APPROVAL_GROUPS). The card still offers
                      * "allow all item creation for this run": a yes given in
                      * the moment, gone when the run ends.
                      */}
                    <FixedPreferenceRow
                        label="Item Imports"
                        description="Adding papers it found in the literature to your library. Every paper is shown to you first; a card can allow the rest of that run."
                        value="Always asks"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_collection"
                        label="Item Organization"
                        description="Creating collections, and adding or removing tags and collections on items"
                    />
                </div>
            </SettingsGroup>
            </div>

            <SectionLabel>System Notifications</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Approval Notifications"
                    description="Show a system notification when AlphainZ is waiting for your decision and is not visible."
                    onClick={handleEnableSystemNotificationsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={enableSystemNotifications}
                            onChange={handleEnableSystemNotificationsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                <SettingsRow
                    title="Response Notifications"
                    description="Show a system notification when a response is ready and AlphainZ is not visible."
                    onClick={handleEnableResponseCompleteNotificationsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={enableResponseCompleteNotifications}
                            onChange={handleEnableResponseCompleteNotificationsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>

            {/*
              * There used to be an "Auto-Apply" group here — two switches,
              * "Auto-Apply Annotations" and "Auto-Create Zotero Notes". They
              * fed the hosted build's post-run action handler, which a run on
              * this fork never reaches (local runs end with no agent_actions
              * frame), so both controlled nothing while sitting next to the
              * PDF Annotations and Note Creation rows that do. Two controls
              * for one thing, one of them dead, is how a permissions page
              * comes to feel untrustworthy. The prefs stay for sync
              * compatibility; the switches are gone.
              */}
            <SectionLabel>File Access</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Access Remote Files"
                    description="Download PDF files from the Zotero server when not available locally"
                    onClick={handleAccessRemoteFilesToggle}
                    tooltip="When enabled, AlphainZ will attempt to download PDFs from the Zotero server or WebDAV if the file is not on your local machine. Disable this if you experience slow responses or don't want remote file downloads."
                    control={
                        <input
                            type="checkbox"
                            checked={accessRemoteFiles}
                            onChange={handleAccessRemoteFilesToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default PermissionsSection;
