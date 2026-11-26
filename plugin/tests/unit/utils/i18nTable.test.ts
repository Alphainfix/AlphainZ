import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- a plain ES module script, without type declarations
import { collectTranslationKeys, placeholders } from '../../../scripts/i18n-keys.mjs';
import { ZH_CN } from '../../../src/i18n/zh-CN';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const keys: Map<string, string[]> = collectTranslationKeys(repo);

describe('the Chinese interface table', () => {
    it('finds the interface strings in the code', () => {
        expect(keys.size).toBeGreaterThan(1000);
    });

    it('has a Chinese entry for every interface string in the code', () => {
        const missing = [...keys.keys()].filter((key) => !Object.prototype.hasOwnProperty.call(ZH_CN, key));
        expect(missing).toEqual([]);
    });

    it('keeps exactly the placeholders of the English in every entry', () => {
        const mismatched = Object.entries(ZH_CN)
            .filter(([key, text]) => placeholders(key).join() !== placeholders(text).join())
            .map(([key, text]) => `${key} → ${text}`);
        expect(mismatched).toEqual([]);
    });

    it('holds no entry the code no longer uses', () => {
        const unused = Object.keys(ZH_CN).filter((key) => !keys.has(key));
        expect(unused).toEqual([]);
    });

    it('leaves no entry empty', () => {
        const empty = Object.entries(ZH_CN).filter(([, text]) => !text.trim()).map(([key]) => key);
        expect(empty).toEqual([]);
    });
});
