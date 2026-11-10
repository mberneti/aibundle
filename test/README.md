# Running the tests

```bash
npm run typecheck   # tsc --noEmit, strict, zero errors expected
npm test            # builds, then runs both suites on the compiled output
npm run verify      # typecheck + tests
```

`npm test` deliberately tests `dist/` — the exact code that ships — rather than
running the TypeScript sources through a loader. If a test fails after an edit,
run `npm run build` first; a stale `dist/` is the usual culprit.

## Layout

| File | What it covers |
| --- | --- |
| `unit.test.ts` | The pure algorithms: token estimation, gitignore matching, secret redaction, the comment-aware compressor, language detection, config resolution, argument parsing, file scoring, import extraction, dependency resolution, the ZIP writer and the small formatting helpers. |
| `e2e.test.ts` | The whole pipeline against real temp projects: scanning, ranking, compression, redaction, every renderer, token budgeting, and the artefacts written to disk. |
| `helpers.ts` | Temp-project factory and the shared React + TypeScript fixture. |

## What the tests are written against

They assert **observable behaviour**, not internals:

- no secret may survive into any rendered output;
- `[object Object]` must never appear (analyzers are rendered, not stringified);
- XML documents must be balanced; ZIP central directories must read back;
- compression must be monotonic across levels and deterministic across runs;
- a second run must not re-scan the output directory;
- the same project twice must produce the same token estimate.

That last group is what protects the promises the README makes. If you change a
rendering detail, update the test only when the new behaviour is *deliberate*.
