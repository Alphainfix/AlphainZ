/**
 * Settings → Model → Providers: the shared provider cards
 * (@beaver/agent-ui/settings/ProviderCards), with Zotero's preferences,
 * dialogs and model list behind them (see settingsHost.tsx).
 */
import React from 'react';
import SharedProviderCards, { type OpenCardRequest } from '@beaver/agent-ui/settings/ProviderCards';
import { ZoteroSettingsHost } from './settingsHost';

export { describeVerdict, type OpenCardRequest } from '@beaver/agent-ui/settings/ProviderCards';

const ProviderCards: React.FC<{ openRequest?: OpenCardRequest | null }> = (props) => (
    <ZoteroSettingsHost>
        <SharedProviderCards {...props} />
    </ZoteroSettingsHost>
);

export default ProviderCards;
