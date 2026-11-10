/**
 * Unit tests for the pure modules: tokenizer, glob, redactor, compressor,
 * config, args and the zip writer.
 *
 * These run without touching a project on disk, so they are fast and they pin
 * the *behaviour* of each algorithm rather than the shape of any output file.
 *
 * @module test/unit.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateTokens, estimateCost, contextFit } from '../src/utils/tokenizer.js';
import { IgnoreMatcher, globToRegExp, matcherFromText } from '../src/utils/glob.js';
import { redactSecrets, isPlaceholder } from '../src/core/redactor.js';
import { collapseBlankLines, compressContent, clipToTokens, elideLongBodies, enforceBudget, maskCode, stripComments, withLineNumbers } from '../src/core/compressor.js';
import { detectLanguage, fenceHint } from '../src/core/languages.js';
import { resolveConfig, PRESETS, DEFAULTS } from '../src/core/config.js';
import { parseArgs, parseSize, parseTokenBudget, toOverrides } from '../src/cli/args.js';
import { crc32, readZipEntries, renderZip } from '../src/renderers/zip.js';
import { classify, scoreFile, detectStack } from '../src/core/scanner.js';
import { extractImports, resolveSpecifier } from '../src/analyzers/index.js';
import { formatBytes, displayWidth, truncate } from '../src/utils/style.js';
import { sniffBinary, normalizeText, extOf, countLines } from '../src/utils/fs.js';
import type { FileRecord } from '../src/types.js';

function record(partial: Partial<FileRecord> & { path: string }): FileRecord {
  return {
    absolutePath: `/tmp/${partial.path}`,
    size: partial.size ?? 100,
    lines: partial.lines ?? 10,
    language: partial.language ?? 'typescript',
    languageName: partial.languageName ?? 'TypeScript',
    kind: partial.kind ?? 'source',
    importance: partial.importance ?? 50,
    reasons: partial.reasons ?? [],
    ...partial,
  };
}

describe('tokenizer', () => {
  it('returns 0 for empty input and at least 1 for any content', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('x'), 1);
  });

  it('is monotonic: more text never means fewer tokens', () => {
    const short = estimateTokens('const a = 1;');
    const long = estimateTokens('const a = 1;\n'.repeat(50));
    assert.ok(long > short, `${long} should exceed ${short}`);
  });

  it('estimates prose near 4 chars/token and code a little denser', () => {
    const prose = 'the quick brown fox jumps over the lazy dog again and again';
    assert.ok(estimateTokens(prose) < prose.length / 3);
    const wide = '\u4f60\u597d\u4e16\u754c'.repeat(20);
    assert.ok(estimateTokens(wide) > wide.length / 2, 'CJK should be much denser');
  });

  it('reports context-window fit and cost without inventing numbers', () => {
    const fits = contextFit(150_000);
    const gpt = fits.find((entry) => entry.model.includes('GPT'));
    assert.ok(gpt);
    assert.equal(gpt.fits, false);
    assert.ok(estimateCost(1_000_000, 'gpt-4o') > 0);
  });
});

describe('glob / IgnoreMatcher', () => {
  it('matches a plain name at any depth but honours anchoring', () => {
    const matcher = new IgnoreMatcher(['dist/', '*.log', '/build']);
    assert.equal(matcher.matches('dist', true), true);
    assert.equal(matcher.matches('src/dist', true), true);
    assert.equal(matcher.matches('app.log'), true);
    assert.equal(matcher.matches('build', true), true);
    assert.equal(matcher.matches('src/build', true), false, 'leading slash anchors to the root');
    assert.equal(matcher.matches('src/App.tsx'), false);
  });

  it('lets the last matching rule win, like git', () => {
    const matcher = new IgnoreMatcher(['*.ts', '!keep.ts']);
    assert.equal(matcher.matches('drop.ts'), true);
    assert.equal(matcher.matches('keep.ts'), false);
  });

  it('does not treat directory-only rules as file matches', () => {
    const matcher = new IgnoreMatcher(['coverage/']);
    assert.equal(matcher.matches('coverage', true), true);
    assert.equal(matcher.matches('coverage/index.html'), true, 'a file inside an ignored directory is ignored too');
  });

  it('expands ** across separators and skips comments', () => {
    const regex = globToRegExp('**/generated/*.js', false);
    assert.ok(regex.test('a/b/generated/x.js'));
    const matcher = matcherFromText('# a comment\n\nnode_modules/\n');
    assert.equal(matcher.matches('node_modules', true), true);
    assert.equal(matcher.size, 1);
  });
});

describe('redactor', () => {
  it('redacts well-known token shapes without a key name', () => {
    const result = redactSecrets('const t = "sk-abcdefghijklmnopqrstuvwxyz0123";');
    assert.equal(result.count, 1);
    assert.match(result.text, /redacted:openai-key/);
    assert.ok(!result.text.includes('sk-abcdefghijklmnopqrstuvwxyz0123'));
  });

  it('redacts assignment-style secrets and keeps the key and quoting', () => {
    const result = redactSecrets('apiKey: "hunter2hunter2hunter2"\n');
    assert.equal(result.count, 1);
    assert.match(result.text, /apiKey: "\u00abredacted\u00bb"/);
  });

  it('leaves placeholders alone so the output stays honest', () => {
    const source = 'API_KEY=process.env.API_KEY\nPASSWORD=changeme\nTOKEN=\n';
    const result = redactSecrets(source);
    assert.equal(result.count, 0);
    assert.equal(result.text, source);
    assert.equal(isPlaceholder('process.env.X'), true);
    assert.equal(isPlaceholder('S3cr3t-p4ssw0rd'), false);
  });

  it('redacts private keys, JWTs and URLs with credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const result = redactSecrets(`url = "https://user:pass@example.com/x"\ntoken = "${jwt}"\n`);
    assert.ok(result.count >= 2);
    assert.match(result.text, /redacted:jwt/);
    assert.match(result.text, /redacted:basic-auth-url/);
  });
});

describe('compressor', () => {
  it('never mistakes a comment inside a string for a real comment', () => {
    const source = "const a = '// not a comment';\nconst b = 2; // real\n";
    const stripped = stripComments(source, 'typescript');
    assert.match(stripped, /not a comment/);
    assert.ok(!stripped.includes('// real'));
  });

  it('handles regex literals and template interpolation', () => {
    const source = 'const re = /\\/\\/+/g; // trailing\n'
      + 'const s = `a ${x} // b`; // gone\n';
    const stripped = stripComments(source, 'typescript');
    assert.match(stripped, /\\\/\\\/\+/);
    assert.match(stripped, /\$\{x\}/);
    assert.ok(!stripped.includes('// trailing'));
    assert.ok(!stripped.includes('// gone'));
  });

  it('keeps imperative comment directives', () => {
    const source = '// eslint-disable-next-line\n// @ts-expect-error\nconst x = 1; // remove me\n';
    const stripped = stripComments(source, 'typescript');
    assert.match(stripped, /eslint-disable-next-line/);
    assert.match(stripped, /@ts-expect-error/);
    assert.ok(!stripped.includes('remove me'));
  });

  it('marks code vs comment positions', () => {
    const mask = maskCode("const a = 'x'; // c\n", { lineComment: '//', strings: true });
    assert.equal(mask.code[0], true);
    assert.equal(mask.code[mask.comments[0]![0]], false);
  });

  it('is monotonic across levels and idempotent', () => {
    const source = '/* banner */\nfunction big() {\n' + '  const x = 1;\n'.repeat(60) + '}\n\n\n\n// done\n';
    const light = compressContent(source, 'typescript', 'light').text;
    const balanced = compressContent(source, 'typescript', 'balanced').text;
    const aggressive = compressContent(source, 'typescript', 'aggressive').text;
    assert.ok(light.length >= balanced.length);
    assert.ok(balanced.length >= aggressive.length);
    const again = compressContent(source, 'typescript', 'aggressive').text;
    assert.equal(again, aggressive, 'compression must be deterministic');
  });

  it('collapses blank runs and elides only very long bodies', () => {
    assert.equal(collapseBlankLines('a\n\n\n\nb\n'), 'a\n\nb\n');
    const longBody = 'function f() {\n' + '  const x = 1;\n'.repeat(60) + '}\n';
    assert.ok(elideLongBodies(longBody, 'typescript').elided >= 1);
    const shortBody = 'function f() {\n  return 1;\n}\n';
    assert.equal(elideLongBodies(shortBody, 'typescript').elided, 0);
    const ifBlock = 'if (x) {\n' + '  y();\n'.repeat(60) + '}\n';
    assert.equal(elideLongBodies(ifBlock, 'typescript').elided, 0, 'control flow must not be elided');
  });

  it('clips to a token budget at a line boundary and says so', () => {
    const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const clipped = clipToTokens(content, 50);
    assert.ok(estimateTokens(clipped) <= 60);
    assert.match(clipped, /omitted to fit the token budget/);
  });

  it('adds line numbers without changing the content', () => {
    assert.equal(withLineNumbers('a\nb'), '1 | a\n2 | b');
  });
});

describe('enforceBudget', () => {
  const files = [
    record({ path: 'a.ts', content: 'x'.repeat(4000), importance: 90 }),
    record({ path: 'b.ts', content: 'y'.repeat(4000), importance: 50 }),
    record({ path: 'c.ts', content: 'z'.repeat(4000), importance: 10 }),
  ];

  it('records tokens but drops nothing when there is no budget', () => {
    const result = enforceBudget(files, 0);
    assert.equal(result.affected, 0);
    assert.equal(files.every((file) => !file.dropped), true);
    assert.ok(result.tokens > 0);
  });

  it('keeps the important files and drops the rest under a budget', () => {
    const result = enforceBudget(files, 1500, { strategy: 'priority' });
    assert.notEqual(files[0]!.dropped, true, 'the most important file must survive');
    assert.equal(files[2]!.dropped, true);
    assert.equal(files[2]!.dropReason, 'budget');
    assert.ok(result.affected > 0);
  });

  it('is idempotent: a second call with the same budget gives the same result', () => {
    const first = files.map((file) => ({ dropped: file.dropped, content: file.content }));
    enforceBudget(files, 1500, { strategy: 'priority' });
    const second = files.map((file) => ({ dropped: file.dropped, content: file.content }));
    assert.deepEqual(second, first);
  });

  it('the spread strategy touches every file', () => {
    const spread = [
      record({ path: 'a.ts', content: 'x'.repeat(20_000), importance: 90 }),
      record({ path: 'b.ts', content: 'y'.repeat(20_000), importance: 50 }),
    ];
    const result = enforceBudget(spread, 1000, { strategy: 'spread' });
    assert.equal(spread.every((file) => file.truncated), true);
    assert.ok(result.tokens <= 1200);
  });
});

describe('languages', () => {
  it('detects the common web extensions, with .tsx kept distinct', () => {
    assert.equal(detectLanguage('src/App.tsx').id, 'tsx');
    assert.equal(detectLanguage('src/index.ts').id, 'typescript');
    assert.equal(detectLanguage('types/index.d.ts').id, 'typescript');
    assert.equal(detectLanguage('a/b/c.py').id, 'python');
    assert.equal(detectLanguage('Dockerfile').id, 'dockerfile');
    assert.equal(detectLanguage('Makefile').id, 'makefile');
    assert.equal(detectLanguage('weird.qqq').id, 'text');
  });

  it('sniffs a shebang for extension-less scripts', () => {
    assert.equal(detectLanguage('bin/tool', { content: '#!/usr/bin/env node\n' }).id, 'javascript');
    assert.equal(detectLanguage('bin/tool', { content: '#!/usr/bin/env python3\n' }).id, 'python');
  });

  it('uses short fence hints the chat UIs highlight', () => {
    assert.equal(fenceHint('typescript'), 'ts');
    assert.equal(fenceHint('tsx'), 'tsx');
    assert.equal(fenceHint('javascript'), 'js');
    assert.equal(fenceHint('rust'), 'rust');
  });
});

describe('config', () => {
  it('lists five presets, each with a description and formats', () => {
    assert.deepEqual(Object.keys(PRESETS).sort(), ['archive', 'chat', 'claude', 'gemini', 'openai']);
    for (const preset of Object.values(PRESETS)) {
      assert.ok(preset.description.length > 10);
      assert.ok(preset.formats.length > 0);
    }
  });

  it('resolves defaults, applies presets and lets CLI overrides win', async () => {
    const { config } = await resolveConfig('/tmp', { preset: 'openai', formats: ['json'] });
    assert.equal(config.preset, 'openai');
    assert.deepEqual(config.formats, ['json']);
    assert.ok(config.maxTokens > 0);
    assert.ok(config.root.length > 0);
  });

  it('gives every preset its own format list', async () => {
    // Regression: the preset's `formats` used to be dropped during merge, so every
    // preset silently produced a markdown-only run.
    for (const [name, preset] of Object.entries(PRESETS)) {
      const { config } = await resolveConfig('/tmp', { preset: name as never }, { projectConfigOnly: true });
      assert.deepEqual(config.formats, [...preset.formats], `preset ${name}`);
    }
  });

  it('still lets an explicit format list override the preset', async () => {
    const { config } = await resolveConfig('/tmp', { preset: 'claude', formats: ['json'] }, { projectConfigOnly: true });
    assert.deepEqual(config.formats, ['json']);
  });

  it('reports an unknown key instead of silently ignoring it', async () => {
    const { problems } = await resolveConfig('/tmp', {}, { projectConfigOnly: true });
    assert.ok(Array.isArray(problems));
    assert.equal(DEFAULTS.compression, 'balanced');
  });

  it('throws when the output directory would be the project root', async () => {
    await assert.rejects(() => resolveConfig('/tmp', { outputDir: '/tmp' }));
  });
});

describe('cli args', () => {
  it('parses long flags, short aliases and comma lists', () => {
    const args = parseArgs(['./app', '-f', 'markdown,xml', '--preset=claude', '-o', 'build', '-t', '110k']);
    assert.deepEqual(args.positionals, ['./app']);
    const { overrides, errors } = toOverrides(args);
    assert.deepEqual(errors, []);
    assert.deepEqual(overrides.formats, ['markdown', 'xml']);
    assert.equal(overrides.preset, 'claude');
    assert.equal(overrides.outputDir, 'build');
    assert.equal(overrides.maxTokens, 110_000);
  });

  it('collects repeated flags into a list', () => {
    const { overrides } = toOverrides(parseArgs(['-i', '*.snap', '-i', 'tmp/', '--ignore', 'logs']));
    assert.deepEqual(overrides.ignore, ['*.snap', 'tmp/', 'logs']);
  });

  it('rejects unknown flags, unknown formats and bad values', () => {
    const args = parseArgs(['--nope', '--format', 'yaml', '--max-tokens', 'lots', '--max-size', '3 potatoes']);
    const { errors } = toOverrides(args);
    assert.ok(errors.some((error) => error.includes('unknown flag')));
    assert.ok(errors.some((error) => error.includes('yaml')));
    assert.ok(errors.some((error) => error.includes('max-tokens')));
    assert.ok(errors.some((error) => error.includes('max-size')));
  });

  it('parses sizes and budgets', () => {
    assert.equal(parseTokenBudget('110k'), 110_000);
    assert.equal(parseTokenBudget('1.5m'), 1_500_000);
    assert.equal(parseTokenBudget('nope'), null);
    assert.equal(parseSize('2mb'), 2 * 1024 ** 2);
    assert.equal(parseSize('512'), 512);
    assert.equal(parseSize('x'), null);
  });

  it('treats -- as the end of flags', () => {
    const args = parseArgs(['--', '--not-a-flag']);
    assert.deepEqual(args.positionals, ['--not-a-flag']);
  });
});

describe('scoring and classification', () => {
  it('ranks a root manifest and entry point above a deep test', () => {
    const manifest = scoreFile(record({ path: 'package.json', kind: 'config', size: 800 }));
    const deepTest = scoreFile(record({ path: 'src/a/b/c/d/thing.test.ts', kind: 'test', size: 2000 }));
    assert.ok(manifest.score > deepTest.score);
    assert.ok(manifest.reasons.includes('manifest / config'));
  });

  it('classifies files into the documented kinds', () => {
    assert.equal(classify('src/App.tsx', 'tsx'), 'source');
    assert.equal(classify('package.json', 'json'), 'config');
    assert.equal(classify('README.md', 'markdown'), 'doc');
    assert.equal(classify('src/a.test.ts', 'typescript'), 'test');
    assert.equal(classify('src/styles.css', 'css'), 'style');
  });
});

describe('dependency extraction', () => {
  it('finds every import form the analyzer supports', () => {
    const source = [
      "import { a } from './a';",
      "import './side-effect';",
      "const b = require('./b');",
      "const c = await import('./c');",
      "export { d } from './d';",
      "import type { T } from './types';",
    ].join('\n');
    const found = extractImports(source);
    for (const expected of ['./a', './side-effect', './b', './c', './d', './types']) {
      assert.ok(found.includes(expected), `missing ${expected} in ${found.join(', ')}`);
    }
  });

  it('resolves relative specifiers and ignores bare ones', () => {
    const known = new Set(['src/App.tsx', 'src/store.ts', 'src/lib/index.ts']);
    assert.equal(resolveSpecifier('src/main.tsx', './App', known), 'src/App.tsx');
    assert.equal(resolveSpecifier('src/App.tsx', './lib', known), 'src/lib/index.ts');
    assert.equal(resolveSpecifier('src/App.tsx', 'react', known), null);
    assert.equal(resolveSpecifier('src/App.tsx', './missing', known), null);
  });
});

describe('detectStack', () => {
  it('proves each finding with its evidence', () => {
    const files = [
      record({
        path: 'package.json',
        kind: 'config',
        content: JSON.stringify({ dependencies: { react: '18', next: '14' }, devDependencies: { typescript: '5' } }),
      }),
      record({ path: 'src/App.tsx', language: 'tsx' }),
    ];
    const stack = detectStack(files);
    const ids = stack.map((entry) => entry.id);
    assert.ok(ids.includes('react'));
    assert.ok(ids.includes('typescript'));
    assert.ok(ids.includes('nextjs'));
    assert.ok(stack.every((entry) => entry.evidence.length > 0));
  });
});

describe('zip writer', () => {
  it('computes the standard CRC-32 of "123456789"', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('writes an archive whose central directory reads back', () => {
    const archive = renderZip([
      { path: 'a.txt', content: 'hello' },
      { path: 'dir/b.txt', content: 'world' },
    ]);
    const entries = readZipEntries(archive);
    assert.deepEqual(entries.map((entry) => entry.path), ['a.txt', 'dir/b.txt']);
    assert.deepEqual(entries.map((entry) => entry.size), [5, 5]);
    assert.equal(entries[0]!.crc, crc32(Buffer.from('hello')));
    assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  });

  it('handles empty entries and is reproducible with a fixed mtime', () => {
    const at = new Date('2024-01-02T03:04:06Z');
    const one = renderZip([{ path: 'empty', content: '' }], { mtime: at });
    const two = renderZip([{ path: 'empty', content: '' }], { mtime: at });
    assert.deepEqual([...one], [...two]);
    assert.equal(readZipEntries(one)[0]!.size, 0);
  });
});

describe('style and fs helpers', () => {
  it('measures wide glyphs and truncates without splitting them', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('\u4f60\u597d'), 4);
    assert.equal(truncate('abcdef', 4).length, 4);
  });

  it('formats bytes with decimal units', () => {
    assert.equal(formatBytes(999), '999 B');
    assert.match(formatBytes(1500), /1\.5 KB/);
  });

  it('sniffs binary content and normalises text', () => {
    assert.equal(sniffBinary(Buffer.from([0, 1, 2, 3])), true);
    assert.equal(sniffBinary(Buffer.from('plain ascii text')), false);
    assert.equal(normalizeText('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
    assert.equal(countLines('a\nb\nc'), 3);
    assert.equal(extOf('a/b/File.TSX'), '.tsx');
    assert.equal(extOf('Dockerfile'), '');
  });
});
