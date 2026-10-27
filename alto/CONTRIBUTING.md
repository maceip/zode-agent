# Contributing to Alto

Use [GitHub issues](https://github.com/block/alto/issues) to report bugs, ask
questions, or discuss a proposed change. Include steps to reproduce a bug and
the Alto version or commit you are running.

## Development setup

Install Node.js 22.19 or newer. Install and authenticate the agent you want to
use; Codex CLI is only required for Codex features. The optional Nix development
shell provides Node 22 and the command-line build tools.

```bash
git clone https://github.com/block/alto.git
cd alto
nix develop # Optional if Node.js is already installed.
npm ci
npm run dev
```

Open the complete URL printed by the server to establish your local browser
session. To run the Electron app during development, use `npm run desktop:dev`.
Building the native Ghostty terminal also requires
macOS and a full Xcode installation; see the
[native terminal instructions](native/ghostty/README.md).

The [README](README.md) covers app installation, and
[Agent providers](docs/agent-providers.md) covers Claude, Gemini, and Pi setup.

On macOS, `nix develop --command npm run build:mac-release` builds a portable app
after `npm ci`. The packager downloads Electron's binary when needed; starting
the development app first is not required. Full Xcode is still required for
the native terminal. CI also runs this build from a fresh Nix environment.

## Making a change

Create a branch for your change. Read the [architecture](docs/architecture.md)
and [plugin authoring guide](docs/plugin-authoring.md) before changing plugin
behavior. Visible features belong in the Cordis program; the kernel handles
transport, plugin loading, native integration, and recovery.

Run the checks before opening a pull request:

```bash
npm run check
```

This runs the design-system audit, TypeScript checks, tests, and production
build. Use `npm test -- tests/example.test.ts` to run a specific test file.
[GitHub Actions](https://github.com/block/alto/actions/workflows/ci.yml) runs
the same checks on pushes to `main` and on pull requests.

In the pull request, explain what behavior changes, why it changes, and how
you tested it. Include screenshots for visible changes. Keep unrelated
changes in separate pull requests.

## Releases

The [release workflow](.github/workflows/release.yml) publishes a portable
macOS app for Apple Silicon to [GitHub Releases](https://github.com/block/alto/releases).
It uses the same Nix build, native module check, and ZIP packaging that run on
pull requests. Only the final publishing job has permission to write releases.

Set the next version with `npm version 0.2.0 --no-git-tag-version`, then commit
both `package.json` and `package-lock.json` and merge that change through a PR.
From the merged commit on `main`, create and push the matching tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "Alto v0.2.0"
git push origin v0.2.0
```

Use the actual version in place of `0.2.0`. CI checks out the tag and rejects a
tag that does not match the package version. After the build passes, it creates
a release with generated notes, `Alto-v0.2.0-macOS-arm64.zip`, and a matching
`.zip.sha256` file. Tags with a version suffix, such as `v0.2.0-rc.1`, create
GitHub prereleases. Published assets are not overwritten on reruns.

To retry a failed release, rerun its workflow or run **Release** from the Actions
tab with the existing tag. The manual trigger builds that tag, regardless of the
branch selected in the Actions UI. If an upload failed and left a draft release,
remove the incomplete draft before retrying.

These builds are ad-hoc signed, without an Apple Developer ID or notarization.
The workflow uses GitHub's built-in token and requires no additional secrets.

## Project governance and license

[CODEOWNERS](CODEOWNERS) lists the default reviewer. Alto follows
[Block's open source governance](GOVERNANCE.md) and uses the
[Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for the original
license notice retained with the imported source.
