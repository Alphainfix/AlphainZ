import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const agentCoreSrc = fileURLToPath(new URL('./packages/agent-core/src', import.meta.url));
const agentUiSrc = fileURLToPath(new URL('./packages/agent-ui/src', import.meta.url));
const agentLlmSrc = fileURLToPath(new URL('./packages/agent-llm/src', import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
        setupFiles: ['tests/setup.ts'],
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            '@beaver/agent-core': agentCoreSrc,
            '@beaver/agent-ui': agentUiSrc,
            '@beaver/agent-llm': agentLlmSrc,
        },
    },
});
