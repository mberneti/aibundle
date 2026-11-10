# aipack — AI Project Packer

Turns any code project into token-optimized context bundles you can paste into an AI chat.
Written in TypeScript, zero runtime dependencies, works for TypeScript/React first and gives a
sensible output for any other language.

## Why

Chat models cannot read your whole repository, and copying files by hand wastes tokens on the
wrong files. `aipack` walks the project, ranks every file by how much a reader actually needs it,
compresses the source, removes secrets, and emits a single bundle in the format your model likes
best.

## Quick start

```bash
npm install
npm run build
node ./bin/aipack.js            # interactive wizard
node ./bin/aipack.js . --preset claude -o .aipack
```

## What it produces

| Format | Use it for |
| --- | --- |
| `markdown` | the default; pastes into any chat |
| `xml` | Claude's `<documents>` layout |
| `json` | programmatic use and round-tripping |
| `plain` | plain text with `## File:` headings, repomix-style |
| `repomix` | familiar to repomix users |
| `zip` | a real archive holding every format plus the raw files |

Plus `REPORT.md` and `manifest.json`, which state exactly what was included, dropped or redacted.

## Presets

`chat`, `claude`, `gemini`, `openai`, `archive` — each sets a sensible format set, compression
level and token budget. Any flag overrides the preset.

## Safety

- **Redaction** runs in two layers: well-known token shapes (`sk-…`, `ghp_…`, `AIza…`, JWTs,
  private-key blocks, URLs with credentials) are caught by shape alone, and `KEY = "value"`
  assignments whose key looks sensitive are caught by name. Placeholders such as
  `process.env.X` or `changeme` are left intact so the output stays honest.
- **The output directory is never scanned**, so a second run cannot eat its own first output.
- **The report is honest**: a file that was dropped for budget reasons is named in `REPORT.md`.

## Compression levels

`none` keeps everything, `light` collapses blank runs, `balanced` also strips comments while
keeping imperative comments (`eslint-disable`, `@ts-expect-error`), `aggressive` additionally
elides long function bodies — never control flow.

## Configuration

A `.aipackrc.json` in the project root is merged with the built-in defaults and the CLI flags
(flags win). Unknown keys are reported rather than ignored.

## Extending

Add an analyzer or a renderer in a few lines — see `docs/EXTENDING.md`. The architecture and the
output schema are described in `docs/ARCHITECTURE.md` and `docs/OUTPUT-SCHEMA.md`.

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # build + node --test (67 tests)
npm run verify      # both
```

## License

MIT — see `LICENSE`.
