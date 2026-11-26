// Lists the interface strings the code passes for translation, so the
// translation table can be checked against them.
//
//   node scripts/i18n-keys.mjs            print the strings with no Chinese
//   node scripts/i18n-keys.mjs --all      print every string, with where it is used
//
// A string counts when it is a literal argument of `t`, `tn`, `tr` or `msg`
// in a file that imports them from one of the translation modules.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOTS = ['react', 'src', 'packages/agent-ui/src', 'packages/agent-core/src', 'packages/agent-llm/src'];
const MODULES = [/\/src\/utils\/i18n$/, /\/utils\/i18n$/, /^\.{1,2}(\/\.\.)*\/i18n$/, /^@beaver\/agent-ui\/i18n$/, /\/i18nNodes$/, /^\.\/i18n$/,
    /^@beaver\/agent-core\/i18n\/translate$/, /\/i18n\/translate$/, /^@beaver\/agent-llm\/i18n$/];
/** Which arguments of each function are interface strings. */
const ARGS = { t: [0], tr: [0], msg: [0], tn: [1, 2] };

function sourceFiles(repo) {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') walk(full);
            } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                out.push(full);
            }
        }
    };
    for (const root of ROOTS) walk(path.join(repo, root));
    return out;
}

/** The text of a string literal, or of literals joined with `+` (long strings split over lines); else null. */
function literalText(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = literalText(node.left);
        const right = literalText(node.right);
        return left !== null && right !== null ? left + right : null;
    }
    return null;
}

/** Every translation string in the sources: Map<string, Array<"file:line">>. */
export function collectTranslationKeys(repo) {
    const keys = new Map();
    for (const file of sourceFiles(repo)) {
        const text = fs.readFileSync(file, 'utf8');
        if (!/\b(t|tn|tr|msg)\(/.test(text)) continue;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        // Local names bound to the translation functions by an import.
        const bound = new Map();
        for (const statement of sf.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
            const spec = statement.moduleSpecifier.text;
            if (!MODULES.some((re) => re.test(spec))) continue;
            const named = statement.importClause?.namedBindings;
            if (!named || !ts.isNamedImports(named)) continue;
            for (const element of named.elements) {
                const imported = (element.propertyName ?? element.name).text;
                if (imported in ARGS) bound.set(element.name.text, imported);
            }
        }
        if (bound.size === 0) continue;
        const rel = path.relative(repo, file);
        const visit = (node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bound.has(node.expression.text)) {
                for (const index of ARGS[bound.get(node.expression.text)]) {
                    const arg = node.arguments[index];
                    const text = arg && literalText(arg);
                    if (text !== null && text !== undefined) {
                        const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
                        if (!keys.has(text)) keys.set(text, []);
                        keys.get(text).push(`${rel}:${line}`);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return keys;
}

/** The `{name}` placeholders of a string, sorted. */
export function placeholders(text) {
    return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const keys = collectTranslationKeys(repo);
    if (process.argv.includes('--all')) {
        for (const [key, where] of keys) console.log(JSON.stringify(key), '\t', where.join(' '));
    } else {
        const tableFile = fs.readFileSync(path.join(repo, 'src/i18n/zh-CN.ts'), 'utf8');
        const missing = [...keys.keys()].filter((key) => !tableFile.includes(JSON.stringify(key)));
        for (const key of missing) console.log(JSON.stringify(key));
        console.error(`${keys.size} strings, ${missing.length} without Chinese`);
    }
}
