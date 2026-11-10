# Extending ai-project-packer (TypeScript)

The packer is built from three small, replaceable layers. Each is registered in a
registry, so extending it means adding a module, not editing the pipeline.

## 1. Types first

Everything the layers exchange lives in `src/types.ts`: `FileRecord`, `ScanResult`,
`Analyzer<TValue>`, `Renderer`, `RenderContext`, `Bundle`, `PackConfig`, `PackReport`.
Read those before writing anything new — they are the contract.

## 2. Writing an analyzer

An analyzer reads the scanned files and returns one section of the report.

```ts
import type { Analyzer } from "../types.js";

export const myAnalyzer: Analyzer<string> = {
  id: "my-analyzer",
  title: "My section",
  render(value, ctx) {
    return `## ${this.title}\n\n${value}\n`;
  },
  run(input, config) {
    const hits = input.files.filter((f) => f.content.includes("TODO"));
    return hits.map((f) => f.relPath).join("\n") || "_none_";
  },
};
```

Register it in `src/analyzers/index.ts` by adding it to the exported registry array.
`runAnalyzers` returns `{ analyzer, value }` pairs; renderers call
`entry.analyzer.render(entry.value, ctx)` — never print the raw value.

## 3. Writing a renderer

A renderer turns the finished `Bundle` into a file.

```ts
import type { Renderer } from "../types.js";

export const myFormat: Renderer = {
  id: "myformat",
  extension: ".myf",
  render(bundle, ctx) {
    return bundle.files.map((f) => `>>> ${f.relPath}\n${f.content}`).join("\n\n");
  },
};
```

Register it in `src/renderers/index.ts`, and add the id to the `OutputFormat` union
and the `formats` list of each preset in `src/core/config.ts`. That last step is easy
to forget: a preset that does not list the format will not emit it.

## 4. Adding a language

Language metadata (comment tokens, fence hint, binary flag) lives in
`src/core/languages.ts`. Add an entry to the table; the scanner picks it up by
extension. If a file type should be skipped entirely, mark it binary.

## 5. Adding a preset

Presets are plain objects in `src/core/config.ts`. A preset sets defaults only;
config-file values and CLI flags override it during the merge. Test that `formats`
survives the merge — that was a real bug once.

## 6. Tests

Tests live in `test/` and run on the compiled output:
`npm run build && node --test dist/test/*.test.js`, or simply `npm test`. Use
`test/helpers.ts` to build a temporary project fixture. Add one unit test for the
new analyzer/renderer and one assertion in the e2e test that the document contains
its output.
