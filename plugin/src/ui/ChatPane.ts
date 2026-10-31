// placeholder illustration
export const chatPaneHTML = `
    <vbox id="alphainz-chat-inner" flex="1">
        <description>Type questions here:</description>
        <textbox id="alphainz-chat-input" multiline="true" flex="0"/>
        <button id="alphainz-chat-send">Send</button>
        <vbox id="alphainz-chat-history" flex="1" style="border: 1px solid gray; overflow:auto;">
            <!-- messages appended dynamically -->
        </vbox>
    </vbox>
`;
