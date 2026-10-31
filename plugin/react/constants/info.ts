
export interface InfoItem {
    title: string;
    description?: string;
    url?: string;
    tooltip?: string;
}

/** Reasons that carry a help link. Empty: no local reason has one. */
export const infoItemList: InfoItem[] = [];

export const getInfoItemByTitle = (title: string): InfoItem | undefined => {
    return infoItemList.find((item) => item.title === title);
};