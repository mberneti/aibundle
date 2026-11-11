# Publishing aibundle

Three things have to line up before `npx aibundle` works for anyone:

1. the code is on GitHub,
2. the package `files` list actually ships the compiled `dist/` and the `bin` shim,
3. the package is published to npm with a `bin` entry named `aibundle`.

The `bin` mapping and the `files` list are already in `package.json`; this document is the
step-by-step for the other two.

---

## 1. Prepare the repository

From the project root:

```bash
git init
git add .
git commit -m "feat: aibundle 2.0.0 (TypeScript)"
```

Add your remote and push:

```bash
git remote add origin git@github.com:OWNER/aibundle.git
git branch -M main
git push -u origin main
```

Replace `OWNER` with your GitHub user or organisation. Then edit these three fields in
`package.json` so the npm page links back correctly:

```json
"repository": "git+https://github.com/OWNER/aibundle.git",
"homepage": "https://github.com/OWNER/aibundle#readme",
"bugs": "https://github.com/OWNER/aibundle/issues"
```

The workflows in `.github/workflows/` start running on the first push:

- `ci.yml` typechecks, tests and smoke-tests the CLI on Node 18, 20 and 22.
- `publish.yml` runs when you push a `v*` tag (or manually from the Actions tab).

## 2. Publish to npm

Create an account at <https://www.npmjs.com/signup>, then log in locally:

```bash
npm login                      # browser flow, or:
npm login --auth-type=legacy   # username / password / email prompts
npm whoami                     # confirms you are authenticated
```

Check the name is still free — package names are global:

```bash
npm view aibundle version
```

If it is taken, rename the package (`"name"` in `package.json`); the command users type is the
package name, so `npx <name>` changes with it.

Now release with the script, which runs `tsc --noEmit`, the test suite, and only then publishes:

```bash
node scripts/publish.mjs --dry-run        # nothing leaves your machine
node scripts/publish.mjs                  # real publish, dist-tag `latest`
```

Useful variations:

```bash
node scripts/publish.mjs --tag beta       # pre-release under the `beta` dist-tag
node scripts/publish.mjs --otp 123456     # account has 2FA enabled
node scripts/publish.mjs --access public  # explicit, though publishConfig already sets it
```

Then push the tag so the release is reproducible:

```bash
git tag -a v2.0.0 -m "v2.0.0"
git push origin main --tags
```

`prepublishOnly` runs `npm run verify`, so even a bare `npm publish` cannot ship a red build.

### Publishing from GitHub Actions

Tag-driven publishing needs one secret: add `NPM_TOKEN` under
**Settings → Secrets and variables → Actions**. Create the token at
<https://www.npmjs.com/settings/~/tokens> as an **Automation** token (it bypasses 2FA in CI).

After that:

```bash
npm version patch          # bumps 2.0.0 -> 2.0.1 and commits the tag
git push origin main --tags
```

The workflow publishes with `--provenance`, so npm shows a verified link from the package back to
the exact commit and workflow run.

### Bumping the version

`npm publish` refuses a version that already exists. Bump it in `package.json` — or with
`npm version patch|minor|major` — before each release. Follow semver: breaking `-` CLI flag or
export change is `major`, a new flag, format or analyzer is `minor`, everything else is `patch`.

## 3. Confirm `npx` works

After the registry has the version (give it a minute):

```bash
npx aibundle@latest --help
npx aibundle@latest . --preset chat -o .aibundle
```

`npx` resolves the package, installs it in a temporary cache and runs the `aibundle` binary, because
`package.json` declares:

```json
"bin": { "aibundle": "./bin/aibundle.js" }
```

Three things break that wiring, so check them if `npx` fails:

- `bin/aibundle.js` must be executable and start with `#!/usr/bin/env node` (it does);
- `dist/` must be in the `files` array, otherwise the shim has nothing to load;
- the version you asked for must actually be on the registry — `npm view aibundle versions`.

## Troubleshooting

| Symptom                               | Cause                                 | Fix                                                       |
| ------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `E403` on publish                     | name taken, or token lacks permission | rename, or recreate an Automation token                   |
| `EPUBLISHCONFLICT`                    | the version already exists            | bump `version` and tag again                              |
| `npx` runs an old build               | npm cache                             | `npx --yes aibundle@latest`, or `npm cache clean --force` |
| `aibundle: compiled output not found` | `dist/` missing from the package      | ensure `dist` is in `files` and run `npm run build`       |
| CI publish step skipped               | tag pushed but no `NPM_TOKEN`         | add the secret, re-run the workflow                       |
| `403 You must verify your email`      | new npm account                       | verify the address from the email npm sent                |

## Release checklist

- [ ] `npm run verify` is green locally
- [ ] `CHANGELOG`/commit messages describe the change
- [ ] `version` bumped and consistent with the tag you will push
- [ ] `node scripts/publish.mjs --dry-run` shows the expected file list
- [ ] published, then `npx aibundle@latest --help` verified on a clean machine
- [ ] tag pushed to GitHub
