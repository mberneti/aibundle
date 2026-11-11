# aibundle — AI Project Packer

Turns any code project into token-optimized context bundles you can paste into an AI chat.
Written in TypeScript, zero runtime dependencies, works for TypeScript/React first and gives a
sensible output for any other language.

[![CI](https://github.com/OWNER/aibundle/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/aibundle/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aibundle.svg)](https://www.npmjs.com/package/aibundle)
[![license](https://img.shields.io/npm/l/aibundle.svg)](./LICENSE)

## Why

Chat models cannot read your whole repository, and copying files by hand wastes tokens on the
wrong files. `aibundle` walks the project, ranks every file by how much a reader actually needs it,
compresses the source, removes secrets, and emits a single bundle in the format your model likes
best.

## Run it without installing

```bash
npx aibundle --help          # once published
npx aibundle . --preset claude -o .aibundle
```

`npx` downloads the package on demand and runs the `aibundle` binary; nothing is added to your
global install. A `Node.js >= 18` runtime has to be present — the package itself has no
dependencies.

## Install

```bash
npm install -g aibundle     # gives you the `aibundle` command
# or, from a clone:
npm install && npm run build && npm link
```

## Quick start

```bash
aibundle                          # interactive wizard in the current directory
aibundle . --yes                  # non-interactive, sensible defaults
aibundle ./my-app --preset claude --toc
aibundle . -f markdown,zip -c aggressive -t 110k
aibundle . --dry-run --verbose    # scan and report, write nothing
```

Or, straight from the source tree without linking:

```bash
node ./bin/aibundle.js --help
```

## What it produces

| Format     | Use it for                                             |
| ---------- | ------------------------------------------------------ |
| `markdown` | the default; pastes into any chat                      |
| `xml`      | Claude's `<documents>` layout                          |
| `json`     | programmatic use and round-tripping                    |
| `plain`    | plain text with `## File:` headings, repomix-style     |
| `repomix`  | familiar to repomix users                              |
| `zip`      | a real archive holding every format plus the raw files |

Plus `REPORT.md` and `manifest.json`, which state exactly what was included, dropped or redacted.

## Presets

`chat`, `claude`, `gemini`, `openai`, `archive` — each sets a sensible format set, compression
level and token budget. Any flag overrides the preset.

| Preset    | Formats                          | Intent                                            |
| --------- | -------------------------------- | ------------------------------------------------- |
| `chat`    | `markdown`                       | fits any chat UI and keeps the full tree          |
| `claude`  | `xml`, `markdown`                | an unambiguous `<documents>` wrapper              |
| `openai`  | `markdown`                       | tuned to a 128k window, trimmed for the answer    |
| `gemini`  | `markdown`, `xml`                | keeps more of the project, for a 1M-token window  |
| `archive` | `markdown`, `json`, `xml`, `zip` | everything, uncompressed, for storage or hand-off |

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

A `.aibundlerc.json` in the project root is merged with the built-in defaults and the CLI flags
(flags win). Unknown keys are reported rather than ignored.

```json
{
  "preset": "claude",
  "formats": ["xml", "markdown"],
  "compression": "balanced",
  "maxTokens": 160000,
  "ignore": ["**/*.snap"],
  "redact": true
}
```

## Library use

```ts
import { packProject, buildBundle, renderReport } from "aibundle";

const bundle = await packProject({ root: process.cwd(), preset: "claude" });
console.log(bundle.totals.files, "files ·", bundle.totals.tokens, "tokens");
```

## Extending

Add an analyzer or a renderer in a few lines — see `docs/EXTENDING.md`. The architecture and the
output schema are described in `docs/ARCHITECTURE.md` and `docs/OUTPUT-SCHEMA.md`.

## Development

```bash
npm ci              # install dev deps (TypeScript + @types/node only)
npm run typecheck   # tsc --noEmit, strict
npm test            # build + node --test (69 tests)
npm run verify      # typecheck, then tests
```

## Publishing

The repository ships a release script, a CI workflow and a tag-driven publish workflow. The full
walk-through is in [`docs/PUBLISHING.md`](./docs/PUBLISHING.md); the short version:

```bash
node scripts/publish.mjs --dry-run   # verify + tests + show the exact tarball
node scripts/publish.mjs             # typecheck, test, then `npm publish`
```

Publishing to npm needs an account (and a token in CI); pushing to GitHub needs a repository you
own. Both steps and the `npx` wiring are explained in `docs/PUBLISHING.md`.

## License

MIT — see `LICENSE`.
