# Output schema

## Bundle

```ts
interface Bundle {
  frontMatter: { title, generatedAt, preset, compression, tool, version, totals };
  scan: ScanResult;            // root, files, ignored, stack, stats
  sections: AnalyzerSection[]; // { id, title, value, render(ctx) }
  files: FileRecord[];         // final, compressed, budgeted
}
```

## FileRecord

```ts
interface FileRecord {
  path: string;                // posix, relative to root
  absolutePath: string;
  size: number; lines: number;
  language: string; languageName: string;
  kind: 'source' | 'config' | 'doc' | 'test' | 'style' | 'asset' | 'other';
  importance: number;          // 0..100
  reasons: string[];           // why that score
  content?: string;            // present when read
  compressed?: string;
  dropped?: true; dropReason?: 'budget' | 'binary' | 'ignored' | 'too-large';
  truncated?: true;
}
```

## Written artefacts

`project-context.{md,xml,json,txt}` per requested format, `project-context.zip`,
`REPORT.md` (what was included, dropped, redacted, and the token/cost estimate) and
`manifest.json` (machine-readable summary of the run).
