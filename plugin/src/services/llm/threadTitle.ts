/**
 * A name for the conversation, written by the model that answered it.
 *
 * The name was the first 35 characters of the opening message, which is a
 * placeholder wearing a title's clothes: "你好呀，帮我归纳一下我划线的句子吧"
 * says nothing about the paper, and a list of them is unreadable. Upstream had
 * a backend generate one; with no backend, the model that just answered is
 * both cheaper and better placed — it has read the thing.
 *
 * One short request, no tools, tight output cap. It runs after the answer is
 * already on screen, so its latency costs nothing, and every failure path
 * leaves the fallback name in place rather than an empty row.
 */

import type { ChatProvider } from './types';

/** Past this the row truncates anyway, and a model asked for less obeys better. */
export const MAX_TITLE_CHARS = 40;

const PROMPT = [
    'Write a title for this conversation: what it is about, not what was asked.',
    `At most ${MAX_TITLE_CHARS} characters.`,
    'Same language as the user wrote in.',
    'No quotation marks, no trailing punctuation, no prefix like "Title:".',
    'Name the specific subject — the paper, the quantity, the method — not the genre.',
    'Reply with the title alone.',
].join(' ');

/**
 * Strip what models add despite being told not to.
 *
 * Quotes, a `Title:` prefix, a trailing full stop, and the stray newline that
 * turns one line into two in a list.
 */
export function cleanTitle(raw: string): string {
    let title = String(raw ?? '').trim();
    if (!title) return '';
    title = title.split('\n')[0].trim();
    title = title.replace(/^(?:title|标题|Title)\s*[:：]\s*/i, '');
    title = title.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '');
    title = title.replace(/[。.、,，；;]+$/g, '');
    title = title.trim();
    return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trim() : title;
}

/**
 * Ask the model for a title. Returns null when it cannot produce a usable one.
 *
 * The answer is clipped rather than sent whole: a title needs the subject, and
 * the opening of a reply carries it. Sending the rest would pay for the whole
 * transcript again on every new conversation.
 */
export async function generateThreadTitle(
    provider: ChatProvider,
    question: string,
    answer: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const q = String(question ?? '').slice(0, 600).trim();
    const a = String(answer ?? '').slice(0, 900).trim();
    if (!q && !a) return null;

    let text = '';
    try {
        await provider.stream(
            {
                messages: [
                    { role: 'system', content: PROMPT },
                    {
                        role: 'user',
                        content: `问题：\n${q}\n\n回答开头：\n${a}`,
                    },
                ],
                tools: [],
                signal,
                maxTokens: 64,
            } as any,
            (event: any) => {
                if (event.type === 'text') text += event.text ?? '';
            },
        );
    } catch {
        return null;
    }

    const title = cleanTitle(text);
    // A model that returned nothing usable, or padded it out to an essay, is
    // worse than the opening line it would replace.
    return title.length >= 2 ? title : null;
}
