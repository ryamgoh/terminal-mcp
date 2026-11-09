# Publishing terminal-mcp

There are three places to publish, and they build on each other. GitHub holds the source and runs CI on real macOS and Linux machines. npm holds the installable package, so any MCP client can start the server with `npx -y <package>` and nobody has to clone or build anything. The official MCP Registry holds only metadata that points at the npm package, so the server can be found by name in registry-aware clients and catalogs. Publish in that order: the registry checks the npm package before it accepts the entry.

| Where | What people get | You need |
|---|---|---|
| GitHub (public repository) | Source, issues, CI on Linux and macOS | A GitHub account |
| npm | `npx -y <package>` in any MCP client | An npm account, plus either 2FA on it or a publish token stored in GitHub |
| MCP Registry (in preview) | Listing as `io.github.<you>/terminal-mcp` | The same GitHub account (used to prove the `io.github.<you>/` namespace) |

Everything here is already wired up: `server.json` for the registry, an `mcpName` field in `package.json`, a `prepack` build, a `version` script that keeps `server.json` in step, and a tag-driven release workflow (`.github/workflows/release.yml`). The steps below were rehearsed end to end with a sample identity, short of the actual uploads.

## 1. Pick the names and fill them in

The unscoped npm names `terminal-mcp`, `mcp-terminal` and `terminal-mcp-server` are taken. A scoped name such as `@your-npm-user/terminal-mcp` is always available to you and avoids npm's "too similar to an existing package" check. Unscoped names that were free on 2026-11-09 include `agent-terminal-mcp`, `pty-terminal-mcp` and `mcp-terminal-controller`.

One command writes your identity into `package.json`, `server.json`, `LICENSE` and `README.md`, and refuses to finish if any placeholder is left:

```bash
node scripts/configure-release.mjs --github-user <your-github-user> --npm-name @<your-npm-user>/terminal-mcp --author "Your Name"
npm test
```

The registry name becomes `io.github.<your-github-user>/terminal-mcp`. Pass `--repo <name>` if the GitHub repository will not be called `terminal-mcp`. You can pass the values in stages (for example GitHub user and author now, npm name later) and rerun it to change one; it reports which values are still missing, and the release workflow refuses to publish until none are.

## 2. Put it on GitHub

```bash
git init && git add -A && git commit -m "terminal-mcp 0.1.0"
gh repo create <your-github-user>/terminal-mcp --public --source . --push
```

(Or create the repository on github.com and push to it.) The CI workflow then runs the suite and the smoke check on Ubuntu and macOS with Node 22 and 24, plus the bash scenarios against macOS's own `/bin/bash`. Wait for the Actions tab to go green before publishing; this is the first run on real Mac hardware.

Keep the repository public if you can. Actions minutes are free for public repositories, while private ones draw on your plan's minutes and macOS runners are billed at a higher rate. npm also only attaches provenance (a verified link from the package to the commit and workflow that built it) when the repository is public.

## 3. First release

npm's trusted publishing can only be set up once the package exists, so the first upload uses a credential. npm requires either two-factor authentication on your account or a granular access token with "Bypass two-factor authentication" ticked; a plain `npm login` on an account without 2FA gets `E403`.

**Without 2FA: from GitHub Actions (how 0.1.0 was published).** On npmjs.com open your avatar → **Access Tokens → Generate New Token → Granular Access Token**. Give it read and write access to all packages (the package does not exist yet, so it cannot be picked by name), a short expiry such as 7 days, and tick "Bypass two-factor authentication". Store it in the repository under **Settings → Secrets and variables → Actions** as `NPM_TOKEN`, so it never leaves GitHub. Then push the tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow runs the tests on Ubuntu and macOS, publishes to npm with the token and provenance, and lists the server in the MCP Registry. npm is phasing this out: from around January 2027 a bypass-2FA token will only be able to stage a release that a maintainer then approves with 2FA ([GitHub changelog, July 2026](https://gh.io/npm-gat-bypass2fa-deprecation)). Treat the token as a stopgap, and move to trusted publishing (step 4) or 2FA before then.

**With 2FA: by hand from your Mac.**

```bash
npm login                       # opens the browser; uses your 2FA
npm ci && npm test
npm publish --dry-run           # expect about 43 files, ~58 kB
npm publish                     # public by default (publishConfig); asks for a 2FA code
npx -y @<your-npm-user>/terminal-mcp --version     # 0.1.0
brew install mcp-publisher
mcp-publisher login github      # prints a code to enter at github.com/login/device
mcp-publisher publish
git tag v0.1.0 && git push --tags   # the release workflow tests and skips both publishes
```

Treat publishing as permanent. npm lets you unpublish freely only in the first 72 hours, and after that only for packages that nothing depends on and few people download; otherwise you can deprecate a version but not remove it. A version number can never be reused, even after unpublishing.

## 4. Switch on automated releases

On npmjs.com, open the package, then **Settings → Trusted publishing**, and choose GitHub Actions. Enter your GitHub user, the repository name and the workflow file name `release.yml`, and allow `npm publish` (configurations created after September 2026 allow only staged publishing unless you opt in). A new configuration expires if it is not used for a successful publish within two days, so do this when you are ready to cut the next release. Once it has worked, delete the `NPM_TOKEN` secret and the token on npmjs.com. npm may ask for a 2FA confirmation to change trusted publishing settings; if you keep 2FA off and cannot set it up, the token path keeps working until npm's January 2027 change. With 2FA on, you can also set **Publishing access** to "Require two-factor authentication and disallow tokens" so that only the workflow and your own 2FA login can publish.

The MCP Registry needs no setup: the workflow logs in with GitHub's OIDC token, which proves it runs in your repository.

## 5. Every release after that

```bash
# add the changes to CHANGELOG.md and commit them, then:
npm version patch               # or minor / major: bumps package.json, syncs server.json, commits, tags v0.1.1
git push --follow-tags
```

The tag starts `release.yml`. It runs the tests and the smoke check on Ubuntu and macOS, refuses to continue if anything is still a placeholder or any version disagrees with the tag, publishes to npm (through trusted publishing when it is configured, otherwise with the `NPM_TOKEN` secret; with provenance either way), validates `server.json`, and publishes it to the MCP Registry. Versions that already exist are skipped, so a failed run can simply be re-run.

## If something goes wrong

| Error | Cause and fix |
|---|---|
| `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required` | The account has no 2FA and the credential is not a bypass-2FA token; use the GitHub Actions path in step 3, or turn on 2FA |
| `ENEEDAUTH` or `E401` in the workflow's npm step | The `NPM_TOKEN` secret is missing, mistyped or expired, or the trusted publisher does not match: check the user, repository and `release.yml` on npmjs.com, and that `repository.url` in `package.json` is exactly your repository |
| `403 ... too similar to existing packages` | npm blocks names close to existing ones; use a scoped name |
| `You cannot publish over the previously published versions` | That version already exists; bump with `npm version patch` |
| `NPM package '...' not found (status: 404)` from the registry right after a first publish | npm processes a new upload for a few minutes before serving it ("Your package is being processed"). The workflow now waits for it; if an older run failed this way, re-run its failed job once `npm view <package>` works |
| `Registry validation failed for package` | The npm package is missing or lacks `mcpName`; publish to npm first, from the configured `package.json` |
| `You do not have permission to publish this server` | The registry name does not start with `io.github.<the account you logged in with>/` |
| `placeholders left; run scripts/configure-release.mjs first` | Step 1 was skipped |
| Your entry disappears from the registry | The registry is in preview and may reset its data; run `mcp-publisher publish` again |
