# Architecture

```
src/
  types.ts              every shared interface
  core/
    config.ts           defaults, presets, .aipackrc merge, validation
    languages.ts        ~47 languages: id, comment tokens, fence hint
    gitignore.ts        gitignore-compatible ignore matching
    redactor.ts         secret redaction (shape + assignment layers)
    scanner.ts          walk, classify, score importance, detect stack
    compressor.ts       comment stripping, elision, token budgeting
    pipeline.ts         scan -> analyze -> compress -> render -> write
  analyzers/index.ts    registry + 5 analyzers (summary, tree, deps, api, todos)
  renderers/index.ts    markdown, xml, json, plain, repomix
  renderers/zip.ts      a real ZIP writer (CRC-32, central directory)
  utils/                fs, glob, style, tokenizer, prompt
  cli/                  args, wizard, run, main
```

The pipeline is one direction: `scanProject` produces a `ScanResult`, `runAnalyzers` turns it into
`AnalyzerSection[]`, `compressFiles` produces the final `FileRecord[]`, and a renderer turns the
whole `Bundle` into text. Every stage is pure or takes its side effects from a single place
(`writeArtefacts`), which is what makes the tests fast and deterministic.
