import { ZOTERO_ICONS } from '../components/icons/ZoteroIcon';
import { msg } from '../../src/utils/i18n';

/** English; shown through `t`. */
export const ANNOTATION_TEXT_BY_TYPE: Record<string, string> = {
    highlight: msg('Highlight'),
    underline: msg('Underline'),
    note: msg('Sticky Note'),
    image: msg('Area'),
};

/** English; shown through `t`. */
export const ANNOTATION_PREVIEW_TEXT_BY_TYPE: Record<string, string> = {
    highlight: msg('Highlighted Text'),
    underline: msg('Underlined Text'),
    note: msg('Sticky Note'),
    image: msg('Selected Area'),
};

export const ANNOTATION_ICON_BY_TYPE: Record<string, string> = {
    highlight: ZOTERO_ICONS.ANNOTATE_HIGHLIGHT,
    underline: ZOTERO_ICONS.ANNOTATE_UNDERLINE,
    note: ZOTERO_ICONS.ANNOTATION,
    text: ZOTERO_ICONS.ANNOTATE_TEXT,
    image: ZOTERO_ICONS.ANNOTATE_AREA,
};
