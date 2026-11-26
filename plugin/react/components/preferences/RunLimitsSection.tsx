/**
 * Settings → Advanced → Limits per Question: the shared section
 * (@beaver/agent-ui/settings/RunLimitsSection) on Zotero's preferences.
 */
import React from 'react';
import SharedRunLimitsSection from '@beaver/agent-ui/settings/RunLimitsSection';
import { ZoteroSettingsHost } from './settingsHost';

const RunLimitsSection: React.FC = () => (
    <ZoteroSettingsHost>
        <SharedRunLimitsSection />
    </ZoteroSettingsHost>
);

export default RunLimitsSection;
