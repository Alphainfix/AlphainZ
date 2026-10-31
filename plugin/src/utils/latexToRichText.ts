/**
 * LaTeX math → the rich text a Zotero annotation comment can show.
 *
 * A Zotero comment is a text field that understands exactly four tags — `<i>`,
 * `<b>`, `<sub>`, `<sup>` — and nothing else: no KaTeX, no MathML. Answers to
 * a selection question are full of formulas, and saved as LaTeX source they
 * read as `x_2^*` and `\frac{1}{x_2}` in the reader's popup. This turns each
 * `$…$` segment into what the field can render: real sub- and superscripts,
 * Unicode Greek letters and operators, fractions on one line.
 *
 * Lossy by design where the field is. A fraction becomes `a/b`, a sum sign is a
 * Σ with its limits as scripts, a matrix is its rows. The sidebar keeps the
 * LaTeX and typesets it; only the copy written into Zotero is converted.
 *
 * Pure string work, no DOM: shared by the esbuild and webpack bundles.
 */

const GREEK: Record<string, string> = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
    pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
    varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ',
    Psi: 'Ψ', Omega: 'Ω',
};

/** Relations are set off by spaces, as LaTeX sets them; everything else is glued. */
const RELATIONS: Record<string, string> = {
    approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', equiv: '≡', neq: '≠', ne: '≠', leq: '≤',
    le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', lesssim: '≲', gtrsim: '≳', to: '→', rightarrow: '→',
    Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', perp: '⊥',
    parallel: '∥', mid: '|',
};

/** Binary operators are set off by spaces too; `a\times b` reads as `a × b`. */
const OPERATORS: Record<string, string> = {
    pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '∗', star: '⋆', oplus: '⊕', otimes: '⊗',
    odot: '⊙', cup: '∪', cap: '∩', setminus: '∖', land: '∧', lor: '∨', wedge: '∧', vee: '∨',
};

const SYMBOLS: Record<string, string> = {
    circ: '∘', bullet: '•',
    infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', iint: '∬',
    uparrow: '↑', downarrow: '↓', langle: '⟨', rangle: '⟩', lVert: '‖', rVert: '‖', Vert: '‖', vert: '|',
    lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮',
    ddots: '⋱', hbar: 'ℏ', ell: 'ℓ', prime: '′', degree: '°', angle: '∠',
    emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
    dagger: '†', ddagger: '‡', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', therefore: '∴', because: '∵',
    colon: ':', quad: ' ', qquad: '  ', space: ' ',
    // Single-character control symbols.
    ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', '{': '{', '}': '}', '%': '%', '&': '&', '$': '$',
    _: '_', '#': '#', '|': '‖', '\\': '\n',
};

const BLACKBOARD: Record<string, string> = {
    R: 'ℝ', Z: 'ℤ', C: 'ℂ', N: 'ℕ', Q: 'ℚ', E: '𝔼', P: 'ℙ', H: 'ℍ', I: '𝕀',
};

/** Combining marks, attached to whatever the accent covers. */
const ACCENTS: Record<string, string> = {
    hat: '̂', widehat: '̂', bar: '̄', overline: '̄', tilde: '̃', widetilde: '̃',
    vec: '⃗', dot: '̇', ddot: '̈', breve: '̆', check: '̌', acute: '́', grave: '̀',
};

/** How many braced arguments a command consumes, for reading `_\mathrm{C}` as one script. */
const ARG_COUNT: Record<string, number> = {
    frac: 2, dfrac: 2, tfrac: 2, sqrt: 1, text: 1, textrm: 1, textnormal: 1, mbox: 1, mathrm: 1, mathit: 1,
    mathsf: 1, mathtt: 1, operatorname: 1, mathnormal: 1, textit: 1, emph: 1, mathbf: 1, boldsymbol: 1,
    bm: 1, textbf: 1, mathbb: 1, mathcal: 1, mathscr: 1, mathfrak: 1, not: 1, begin: 1, end: 1, label: 1,
    tag: 1, phantom: 1, hphantom: 1, vphantom: 1, left: 1, right: 1,
    ...Object.fromEntries(Object.keys(ACCENTS).map((name) => [name, 1])),
};

/** `±` and `∓` where they are signs rather than operations: `|±1⟩`, `m=±1`, `(±2)`. */
const SIGNS: Record<string, string> = { pm: '±', mp: '∓' };

const AFTER_RELATION_OR_OPERATOR = new Set([...Object.values(RELATIONS), ...Object.values(OPERATORS)]);

/** Whether an operand starts right after `before`, the output so far, so that a `±` there is its sign. */
function startsOperand(before: string): boolean {
    const text = before.trimEnd();
    if (!text || /<(sub|sup|i|b)>$/.test(text)) return true;
    if (/<\/(sub|sup|i|b)>$/.test(text)) return false;
    const last = text[text.length - 1];
    // A bar opens a ket (`|±1⟩`) where an operand could start, and closes `|a|` elsewhere.
    if (last === '|') return text.length === 1 || /[\s([{⟨=]/.test(text[text.length - 2]);
    return /[([{⟨=<>,;:]/.test(last) || AFTER_RELATION_OR_OPERATOR.has(last);
}

const SIZE_COMMANDS = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr']);
const DROPPED = new Set([
    'nonumber', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits',
    'mathstrut', 'strut', 'relax',
]);

/** Which script tags are already open around the text being converted. */
interface Context {
    sub: boolean;
    sup: boolean;
}

const TOP: Context = { sub: false, sup: false };

/**
 * One LaTeX math expression, without its delimiters, as Zotero rich text.
 */
export function mathToRichText(source: string): string {
    return convert(source, TOP)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/([([⟨]) +/g, '$1')
        .replace(/ +([)\]⟩])/g, '$1')
        .replace(/ *\n */g, '\n')
        .trim();
}

/**
 * Replace every math segment in a piece of prose — `$…$`, `$$…$$`, `\(…\)`,
 * `\[…\]` — with its rich-text rendering. Text outside math is untouched, so a
 * price keeps its dollar sign and `read_document` keeps its underscore.
 *
 * The inline rule is the renderer's own: a `$` only opens math when a
 * non-space follows it and the closing `$` has a non-space before it, which
 * is what tells `$x_2$` from "$5 and $10".
 */
export function convertMathInText(text: string): string {
    return replaceMath(text, mathToRichText);
}

/** Every math segment in `text`, found as {@link convertMathInText} finds them, replaced with `render(source)`. */
export function replaceMath(text: string, render: (source: string) => string): string {
    return text.replace(MATH_SEGMENT, (_match, display, bracket, paren, inline) =>
        render(display ?? bracket ?? paren ?? inline ?? ''),
    );
}

const MATH_SEGMENT = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\((.+?)\\\)|\$(\S(?:[^$\n]*\S)?)\$/g;

/**
 * One LaTeX math expression as plain characters, for text that shows neither
 * LaTeX nor tags, such as a one-line preview. A script becomes Unicode script
 * characters when every character in it has one (`x₂`, `¹³C`, `10⁻³`), and
 * stays `_x` / `^x` when not.
 */
export function mathToPlainText(source: string): string {
    let text = mathToRichText(source).replace(/<\/?[ib]>/g, '');
    // Innermost first: a superscript can hold a subscript, and the other way round.
    for (let previous = ''; previous !== text;) {
        previous = text;
        text = text.replace(/<(sub|sup)>([^<]*)<\/\1>/g, plainScript);
    }
    // What is left holds a literal `<`, as in `x_{a<b}`.
    return text
        .replace(/<(sub|sup)>(.*?)<\/\1>/g, plainScript)
        .replace(/<\/?(sub|sup)>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const SUPERSCRIPTS: Record<string, string> = {
    0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
    '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ',
    // Already written high: `x₂*`, `M†`, `x′`.
    '*': '*', '∗': '*', '†': '†', '‡': '‡', '′': '′', '″': '″', '‴': '‴', '°': '°',
};

const SUBSCRIPTS: Record<string, string> = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
    '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
    s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** A `<sub>` or `<sup>` and its content, as plain characters. */
function plainScript(_match: string, tag: string, inner: string): string {
    const glyphs = tag === 'sub' ? SUBSCRIPTS : SUPERSCRIPTS;
    const chars = Array.from(inner);
    if (chars.every((char) => char in glyphs)) return chars.map((char) => glyphs[char]).join('');
    const mark = tag === 'sub' ? '_' : '^';
    return isAtom(inner) ? `${mark}${inner}` : `${mark}(${inner})`;
}

// ---------------------------------------------------------------------------
// The converter proper: a small reader over the LaTeX source.
// ---------------------------------------------------------------------------

function convert(src: string, ctx: Context): string {
    const out: string[] = [];
    const n = src.length;
    let i = 0;

    const skipSpaces = () => {
        while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
    };

    /** Read a `{…}` group starting at `i`, returning its inside. */
    const readGroup = (): string => {
        let depth = 0;
        let j = i;
        for (; j < n; j++) {
            const c = src[j];
            if (c === '\\') {
                j++;
                continue;
            }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) break;
            }
        }
        const inner = src.slice(i + 1, Math.min(j, n));
        i = j + 1;
        return inner;
    };

    /** Read a control word or control symbol starting at the backslash at `i`. */
    const readCommandName = (): string => {
        const match = /^([A-Za-z]+|[\s\S])/.exec(src.slice(i + 1));
        const name = match ? match[1] : '';
        i += 1 + name.length;
        return name;
    };

    /** Read one argument as raw source: a group, a command with its own arguments, or a character. */
    const readArg = (): string => {
        skipSpaces();
        if (i >= n) return '';
        if (src[i] === '{') return readGroup();
        if (src[i] === '\\') {
            const start = i;
            const name = readCommandName();
            if (name === 'sqrt') readOptional();
            for (let k = 0; k < (ARG_COUNT[name] ?? 0); k++) {
                skipSpaces();
                if (src[i] === '{') readGroup();
                else if (src[i] === '\\') readCommandName();
                else i++;
            }
            return src.slice(start, i);
        }
        return src[i++] ?? '';
    };

    /** Read a `[…]` optional argument if one follows. */
    const readOptional = (): string | null => {
        skipSpaces();
        if (src[i] !== '[') return null;
        const end = src.indexOf(']', i);
        if (end < 0) return null;
        const inner = src.slice(i + 1, end);
        i = end + 1;
        return inner;
    };

    while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
            const name = readCommandName();
            // A control word swallows the spaces after it, as in LaTeX.
            if (/^[A-Za-z]+$/.test(name)) skipSpaces();
            if (name in SIGNS && startsOperand(out.join(''))) out.push(SIGNS[name]);
            else out.push(command(name, ctx, readArg, readOptional, () => src[i] ?? ''));
        } else if (ch === '^' || ch === '_') {
            i++;
            out.push(script(ch, readArg(), ctx));
        } else if (ch === '{') {
            out.push(convert(readGroup(), ctx));
        } else if (ch === '}') {
            i++;
        } else if (ch === "'") {
            let count = 0;
            while (src[i] === "'") {
                count++;
                i++;
            }
            out.push(count === 1 ? '′' : count === 2 ? '″' : '‴');
        } else if (ch === '~' || ch === '&') {
            out.push(' ');
            i++;
        } else {
            out.push(ch);
            i++;
        }
    }
    return out.join('');
}

function command(
    name: string,
    ctx: Context,
    readArg: () => string,
    readOptional: () => string | null,
    peek: () => string,
): string {
    switch (name) {
        case 'left':
        case 'right': {
            const delimiter = readArg();
            return delimiter === '.' ? '' : convert(delimiter, ctx);
        }
        case 'frac':
        case 'dfrac':
        case 'tfrac': {
            const numerator = convert(readArg(), ctx);
            const denominator = convert(readArg(), ctx);
            return `${wrap(numerator)}/${wrap(denominator)}`;
        }
        case 'sqrt': {
            const index = readOptional();
            const body = convert(readArg(), ctx);
            const radicand = isAtom(body) ? body : `(${body})`;
            if (index === null) return `√${radicand}`;
            if (index === '3') return `∛${radicand}`;
            if (index === '4') return `∜${radicand}`;
            return `${radicand}${script('^', `1/${index}`, ctx)}`;
        }
        case 'text':
        case 'textrm':
        case 'textnormal':
        case 'mbox':
            return restoreEscapes(readArg());
        case 'mathrm':
        case 'mathit':
        case 'mathsf':
        case 'mathtt':
        case 'mathnormal':
        case 'operatorname':
        case 'mathcal':
        case 'mathscr':
        case 'mathfrak':
            return convert(readArg(), ctx);
        case 'textit':
        case 'emph':
            return `<i>${convert(readArg(), ctx)}</i>`;
        case 'mathbf':
        case 'boldsymbol':
        case 'bm':
        case 'textbf':
            return `<b>${convert(readArg(), ctx)}</b>`;
        case 'mathbb':
            return convert(readArg(), ctx).replace(/[A-Z]/g, (letter) => BLACKBOARD[letter] ?? letter);
        case 'begin':
        case 'end':
        case 'label':
        case 'tag':
        case 'phantom':
        case 'hphantom':
        case 'vphantom':
            readArg();
            return '';
        case 'not':
            return `${convert(readArg(), ctx)}̸`;
        default:
            break;
    }
    if (SIZE_COMMANDS.has(name) || DROPPED.has(name)) return '';
    if (name in ACCENTS) return `${convert(readArg(), ctx)}${ACCENTS[name]}`;
    if (name in GREEK) return GREEK[name];
    if (name in RELATIONS) return ` ${RELATIONS[name]} `;
    if (name in OPERATORS) return ` ${OPERATORS[name]} `;
    if (name in SYMBOLS) return SYMBOLS[name];
    // A function name — and an unknown command, which reads better as its
    // name than as a backslash. `\ln x` keeps its space; `\sin(x)` and
    // `\exp\left(` do not need one.
    return /[A-Za-z0-9]/.test(peek()) ? `${name} ` : name;
}

function script(kind: '^' | '_', arg: string, ctx: Context): string {
    const trimmed = arg.trim();
    if (kind === '^') {
        if (trimmed === '\\circ' || trimmed === '\\degree') return '°';
        const primes = trimmed.match(/^(\\prime)+$/) ? trimmed.split('\\prime').length - 1 : 0;
        if (primes) return primes === 1 ? '′' : primes === 2 ? '″' : '‴';
    }
    const inner = convert(arg, { sub: ctx.sub || kind === '_', sup: ctx.sup || kind === '^' }).trim();
    if (!inner) return '';
    // Zotero finds a tag's end at the first closing tag of its kind, so a
    // <sub> inside a <sub> would end the outer one early. A nested script of
    // the same kind stays as written.
    if (kind === '_' ? ctx.sub : ctx.sup) return `${kind}${inner}`;
    return kind === '_' ? `<sub>${inner}</sub>` : `<sup>${inner}</sup>`;
}

/** Parenthesise a fraction's side unless it is a single quantity. */
function wrap(side: string): string {
    return isAtom(side) ? side : `(${side})`;
}

function isAtom(rich: string): boolean {
    const plain = rich.replace(/<\/?(sub|sup|i|b)>/g, '');
    const body = plain.replace(/^[-−+]/, '');
    return body.length > 0 && !/[\s+\-−±∓×·∗/=<>≤≥≈∼≠]/.test(body);
}

function restoreEscapes(text: string): string {
    return text.replace(/\\([{}%&$_#])/g, '$1').replace(/\\[,;:]/g, ' ').replace(/~/g, ' ');
}
