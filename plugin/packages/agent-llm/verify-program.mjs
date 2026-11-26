/* global process, console */
// Gate for the @beaver/agent-llm package, the model layer shared by the Zotero
// plugin and the Obsidian plugin. Asserts four properties of the standalone
// TypeScript program:
//
// 1. The compiler options that make the isolation meaningful hold exactly:
//    `types` present and empty (no installed @types package, zotero-types
//    above all, becomes ambient), `lib` exactly ES2020 + DOM, and `paths`
//    mapping nothing but @beaver/agent-core. Each is asserted at its one
//    allowed value, so widening it is a visible edit.
// 2. Every file in the program is this package's own source, agent-core's
//    source, or a TypeScript lib file. This is what catches the layer reaching
//    back into the Zotero plugin (src/, react/) or into an @types package.
// 3. Every import a package file writes is relative and stays inside the
//    package, or names @beaver/agent-core. No npm dependency, no Node builtin,
//    no `/// <reference>` directive: each would hand the layer a surface some
//    client lacks.
// 4. The package has no node_modules of its own.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(pkgDir, "src");
const coreSrcDir = path.resolve(pkgDir, "..", "agent-core", "src");
const configPath = path.join(pkgDir, "tsconfig.json");

const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgDir);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
}

const errors = [];
const rel = (file) => path.relative(pkgDir, file);
const inside = (dir, file) => {
  const r = path.relative(dir, file);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

// 1. Compiler options.
if (!Array.isArray(parsed.options.types) || parsed.options.types.length > 0) {
  errors.push(`tsconfig \`types\` must be present and empty; it is ${JSON.stringify(parsed.options.types)}.`);
}
const libs = (parsed.options.lib ?? []).map((lib) => lib.toLowerCase()).sort();
if (JSON.stringify(libs) !== JSON.stringify(["lib.dom.d.ts", "lib.es2020.d.ts"])) {
  errors.push(`tsconfig \`lib\` must be exactly ["ES2020", "DOM"]; it is ${JSON.stringify(parsed.options.lib)}.`);
}
const pathKeys = Object.keys(parsed.options.paths ?? {});
if (JSON.stringify(pathKeys) !== JSON.stringify(["@beaver/agent-core/*"])) {
  errors.push(`tsconfig \`paths\` may map only "@beaver/agent-core/*"; it maps ${JSON.stringify(pathKeys)}.`);
}

// 4. No install of its own.
if (ts.sys.directoryExists(path.join(pkgDir, "node_modules"))) {
  errors.push("packages/agent-llm/node_modules exists — the package must resolve everything from the repo root.");
}

// 2. The program's closure.
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const tsLibDir = path.dirname(ts.getDefaultLibFilePath(parsed.options));
for (const sf of program.getSourceFiles()) {
  const file = path.resolve(sf.fileName);
  if (inside(srcDir, file) || inside(coreSrcDir, file)) continue;
  if (path.dirname(file) === tsLibDir && /^lib\..*\.d\.ts$/.test(path.basename(file))) continue;
  errors.push(`program reaches outside the package and agent-core: ${rel(file)}`);
}

// 3. What the package's own files import.
const packageFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) packageFiles.push(full);
  }
};
walk(srcDir);
for (const file of packageFiles) {
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  for (const ref of [...info.referencedFiles, ...info.typeReferenceDirectives, ...info.libReferenceDirectives]) {
    errors.push(`${rel(file)}: /// <reference> "${ref.fileName}" — declare what the layer needs through an import instead.`);
  }
  for (const { fileName: spec } of info.importedFiles) {
    if (spec.startsWith(".")) {
      const target = path.resolve(path.dirname(file), spec);
      if (!inside(srcDir, target)) errors.push(`${rel(file)}: "${spec}" leaves the package.`);
    } else if (!/^@beaver\/agent-core\/[^.]/.test(spec)) {
      errors.push(`${rel(file)}: "${spec}" — the layer may import only its own files and @beaver/agent-core.`);
    }
  }
}

if (errors.length > 0) {
  console.error(`agent-llm verify-program: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`agent-llm verify-program: OK (${packageFiles.length} files, closure inside the package and agent-core)`);
