/**
 * The Ollama guide (@beaver/agent-ui/settings/OllamaGuide), with this
 * plugin's Ollama service and preferences behind it (see settingsHost.tsx).
 */
import React from 'react';
import { OllamaGuide as SharedOllamaGuide, type OllamaGuideProps } from '@beaver/agent-ui/settings/OllamaGuide';
import { ZoteroSettingsHost } from './settingsHost';

export { recordOllamaStatus, refreshOllamaStatus } from './settingsHost';
export type { OllamaGuideProps } from '@beaver/agent-ui/settings/OllamaGuide';

export const OllamaGuide: React.FC<OllamaGuideProps> = (props) => (
    <ZoteroSettingsHost>
        <SharedOllamaGuide {...props} />
    </ZoteroSettingsHost>
);

export default OllamaGuide;
