#!/usr/bin/env node
/**
 * One-command release for ai-project-packer.
 *
 *   node scripts/publish.mjs --dry-run        # verify + show exactly what would ship
 *   node scripts/publish.mjs                  # verify, then publish to npm as `latest`
 *   node scripts/publish.mjs --tag beta       # publish under another dist-tag
 *   node scripts/publish.mjs --otp 123456     # when the account has 2FA enabled
 *
 * The script is deliberately boring: every step shells out to the npm CLI so the
 * output you see here is the output npm really produces. Order matters —
 * nothing is published until typecheck and the test suite are green.
 *
 * Exit codes: 0 ok, 1 a step failed, 2 usage error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

if (has('--help') || has('-h')) {
  process.stdout.write(
    [
      'Usage: node scripts/publish.mjs [options]',
      '',
      '  --dry-run          run every check and show the tarball, publish nothing',
      '  --skip-checks      skip typecheck/tests (emergency only)',
      '  --tag <name>       npm dist-tag to publish under (default: latest)',
      '  --otp <code>       one-time password, for accounts with 2FA',
      '  --access <mode>    public or restricted (default: public)',
      '  --no-git-check     do not warn about uncommitted or untagged work',
      '  -h, --help         this screen',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const dryRun = has('--dry-run');
const skipChecks = has('--skip-checks');
const gitCheck = !has('--no-git-check');
const tag = valueOf('--tag') ?? 'latest';
const otp = valueOf('--otp');
const access = valueOf('--access') ?? 'public';

if (valueOf('--tag') === undefined && argv.includes('--tag')) {
  process.stderr.write('--tag needs a value\n');
  process.exit(2);
}

// ------------------------------------------------------------------ helpers
const step = (title) => process.stdout.write(`\n\u001b[1m▸ ${title}\u001b[22m\n`);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function capture(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function fail(message) {
  process.stderr.write(`\n\u001b[31m✖ ${message}\u001b[39m\n`);
  process.exit(1);
}

// ------------------------------------------------------------ sanity checks
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

if (pkg.private === true) fail('package.json is marked private; remove that before publishing.');
if (!pkg.name || !pkg.version) fail('package.json needs both a name and a version.');
if (!pkg.bin || Object.keys(pkg.bin).length === 0) {
  fail('package.json needs a `bin` entry, otherwise `npx <name>` has nothing to run.');
}
if (!pkg.files || !pkg.files.includes('dist')) {
  fail('package.json must ship `dist` in `files`, or the published package is empty.');
}

process.stdout.write(
  `\u001b[1m${pkg.name}\u001b[22m \u001b[2m${pkg.version}\u001b[22m\n` +
    `dist-tag : ${tag}\n` +
    `access   : ${access}\n` +
    `mode     : ${dryRun ? 'dry run (nothing is published)' : 'publish'}\n`,
);

// ------------------------------------------------------------------- checks
if (!skipChecks) {
  step('typecheck (tsc --noEmit, strict)');
  run('npm', ['run', 'typecheck']);

  step('tests (build + node --test)');
  run('npm', ['test']);
} else {
  process.stdout.write('\n\u001b[33m! checks skipped on request\u001b[39m\n');
  step('build');
  run('npm', ['run', 'build']);
}

// ------------------------------------------------------- what would ship?
step('tarball contents (npm pack --dry-run)');
run('npm', ['pack', '--dry-run']);

const size = capture('npm', ['pack', '--dry-run', '--json']);
try {
  const parsed = JSON.parse(size);
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (info) {
    process.stdout.write(
      `\n\u001b[2mpackage size: ${(info.size / 1024).toFixed(1)} kB · ` +
        `unpacked: ${(info.unpackedSize / 1024).toFixed(1)} kB · ` +
        `${info.entryCount ?? info.files?.length ?? '?'} files\u001b[22m\n`,
    );
  }
} catch {
  /* the human-readable table above is enough */
}

// ------------------------------------------------------------ git hygiene
if (gitCheck) {
  step('git status');
  const insideRepo = capture('git', ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!insideRepo) {
    process.stdout.write('\u001b[33m! not a git repository — skip this once, then `git init`\u001b[39m\n');
  } else {
    const dirty = capture('git', ['status', '--porcelain']);
    if (dirty) {
      process.stdout.write('\u001b[33m! uncommitted changes present:\u001b[39m\n');
      process.stdout.write(dirty.split('\n').map((line) => `  ${line}`).join('\n') + '\n');
      process.stdout.write('  Publish from a clean tree so the tag matches what shipped.\n');
    } else {
      process.stdout.write('clean\n');
    }
    const existing = capture('git', ['tag', '--list', `v${pkg.version}`]);
    if (existing) process.stdout.write(`\u001b[33m! tag v${pkg.version} already exists locally\u001b[39m\n`);
  }
}

// --------------------------------------------------------------- publish
if (dryRun) {
  step('done — dry run, npm was not touched');
  process.stdout.write(
    'Re-run without --dry-run to publish. After that:\n' +
      `  git tag v${pkg.version} && git push origin main --tags\n`,
  );
  process.exit(0);
}

step(`npm publish --tag ${tag} --access ${access}`);
const publishArgs = ['publish', '--tag', tag, '--access', access, '--ignore-scripts'];
if (otp) publishArgs.push('--otp', otp);
run('npm', publishArgs);

step('published');
process.stdout.write(
  `${pkg.name}@${pkg.version} is on the registry.\n\n` +
    'Now tag and push the commit so the release is reproducible:\n' +
    `  git add -A && git commit -m "release: v${pkg.version}"\n` +
    `  git tag -a v${pkg.version} -m "v${pkg.version}"\n` +
    '  git push origin main --tags\n\n' +
    `Anyone can now run it with:  npx ${pkg.name} --help\n`,
);
