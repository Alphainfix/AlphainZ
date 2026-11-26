import React from "react";
import PreferenceToggle from "./PreferenceToggle";
import { getPref, setPref } from "../../../src/utils/prefs";
import { t } from '../../../src/utils/i18n';

interface AddSelectedItemsOnOpenToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const AddSelectedItemsOnOpenToggle: React.FC<AddSelectedItemsOnOpenToggleProps> = ({ checked, onChange }) => {
    const handleChange = (newValue: boolean) => {
        setPref("addSelectedItemsOnOpen", newValue);
        onChange(newValue);
    };

    return (
        <PreferenceToggle
            checked={checked}
            onChange={handleChange}
            title={t('Add Selected Items When Opening AlphainZ')}
            description={t('Automatically include items selected in Zotero when opening the AlphainZ sidebar.')}
            tooltip={t('When enabled, any items you have selected in Zotero will be automatically added as sources when you open AlphainZ.')}
        />
    );
};

export default AddSelectedItemsOnOpenToggle; 