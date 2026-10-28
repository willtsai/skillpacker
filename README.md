# Skillpacker

**Dependency resolution and reproducible bundling for agent skills.**

Skillpacker is a local-first CLI that also runs in CI. Declare packages of skills,
resolve their recursive dependencies, lock exact Git commits and content hashes,
and assemble self-contained portable, Copilot, or Claude Code bundles.

**Available on npm:** [`@willtsai/skillpacker`](https://www.npmjs.com/package/@willtsai/skillpacker),
starting with version 0.1.1.

The npm package is scoped to `@willtsai`; the tool and CLI command remain
`skillpacker`. The unscoped npm name is not used.

## Requirements and installation

- Node.js 20.19 or later
- npm
- Git with access to your dependency repositories

Use Node.js 24 for new build pipelines. Compatibility tests cover Node.js 20.19.0,
22, and 24 on Linux, macOS, and Windows.

### Build scripts and CI

Install an exact version as a project development dependency:

```sh
npm install --save-dev --save-exact @willtsai/skillpacker@0.1.1
```

Commit `package.json` and `package-lock.json`. Add scripts to your consumer's
`package.json` so npm uses the locally installed command:

```json
{
  "scripts": {
    "skills:version": "skillpacker --version",
    "skills:check": "skillpacker validate",
    "skills:build": "skillpacker build --target copilot --out bundles/release"
  }
}
```

After declaring your skills and resolving their lockfile, subsequent builds need:

```sh
npm ci --include=dev
npm run skills:version
npm run skills:check
npm run skills:build
```

The npm package contains compiled JavaScript. Installing it requires neither a
Skillpacker checkout nor TypeScript, and runs no compilation step. Git is still
required to retrieve Git-based skill dependencies.

Library consumers import from `@willtsai/skillpacker`, not `skillpacker`:

```js
import { JsonManifestReader, Sources, resolveLock, verifyLock, buildBundle } from "@willtsai/skillpacker";
```

The npm lockfile pins the tool and its dependencies; `skillpacker.lock.json` pins
the skills. Keep both. Use fresh output directories: builds refuse to overwrite
existing output. A global install or an unpinned `npx` invocation is not a substitute
for a committed npm lockfile in CI.

### Interactive use

You can install the CLI globally:

```sh
npm install --global @willtsai/skillpacker@0.1.1
skillpacker --version
skillpacker --help
```

Global installation pins the tool version but does not provide a project lockfile.
Nothing is installed into an agent host automatically.

### Development and tarball installation

From a Skillpacker source checkout:

```sh
npm ci
npm test
npm run test:package
node dist/src/cli.js --help
npm pack
```

`npm pack` builds `willtsai-skillpacker-0.1.1.tgz`. A consumer can install that distribution
without rebuilding Skillpacker:

```sh
npm install --save-dev --save-exact /path/to/willtsai-skillpacker-0.1.1.tgz
```

An absolute local tarball path is useful for testing, but is not portable to CI.
Use the published package for shared lockfiles, or keep the tarball at a
repository-relative path available to every build.

`npm run test:package` packs and installs the CLI in a temporary consumer, tests the
command shim and library import, reinstalls with `npm ci`, and checks frozen builds
and failures. It disables install scripts and verifies that TypeScript is absent.
It needs access to your configured npm registry or a populated npm cache.
Set `SKILLPACKER_TARBALL` to an existing tarball path to test those exact bytes
instead of packing again. Temporary test files are removed afterward.

For source development, `npm link` can expose the checkout's CLI locally.

## Try the included example

The source checkout includes an example with a root skill and a separate local skill
source with **no Skillpacker manifest**. The consumer selects what to bundle:

```sh
node dist/src/cli.js resolve --cwd examples/demo
node dist/src/cli.js validate --cwd examples/demo
node dist/src/cli.js build --cwd examples/demo --target copilot --out ../../bundles/demo
```

The resulting directory contains both skills, their bundled resources, license
notices, provenance, the lockfile, and a Copilot `plugin.json`.
Use a different output directory on subsequent builds: existing outputs are never
deleted or overwritten.

## Commands

| Command | Behavior |
| --- | --- |
| `skillpacker init --name my-bundle` | Create a v1 manifest without overwriting an existing file |
| `skillpacker resolve` | Resolve the entire graph, selecting highest compatible versions with backtracking, and write a lockfile |
| `skillpacker validate` | Verify root content, exact locked sources, hashes, and dependency constraints |
| `skillpacker build --target portable --out bundles/release` | Verify the lock and assemble a bundle in a new directory |
| `skillpacker --version` | Print the installed package version |

All commands accept `--cwd DIRECTORY`. Commands are noninteractive, print errors
to stderr, and exit nonzero on failure. `build` and `validate` are always frozen:
they never resolve newer versions or repair a stale lock. There is no separate
`--frozen-lockfile` flag.

## Dependency manifest

`skillpacker.json` is Skillpacker's own format, **not an Agent Skills standard**.
A root package owns a name, version, exported skill directories, and dependency
declarations. It can export no skills and serve only as an aggregation package.
Dependencies can be plain skill sources or manifest-aware packages.

### Plain skill sources (no upstream changes)

Declare `package` alongside the source to supply the packaging metadata yourself.
Skillpacker reads the selected skills' `SKILL.md` files but does **not** read any
upstream `skillpacker.json`, even if upstream adds one later. No fork or wrapper
repository is needed.

```json
{
  "schemaVersion": 1,
  "name": "my-cabinet",
  "version": "1.0.0",
  "skills": ["skills/product-ceo"],
  "dependencies": {
    "writing-tools": {
      "source": {
        "type": "git",
        "url": "https://github.com/ryanwaite/copilot-skills.git",
        "ref": "<full-commit-sha>"
      },
      "package": {
        "skills": ["writing-coach", "classic-style"],
        "notices": ["LICENSE"]
      }
    }
  },
  "notices": ["legal/attributions.txt"]
}
```

Replace `<full-commit-sha>` with a reviewed upstream commit. The dependency key
(`writing-tools`) is your package identity, not a name that upstream must declare.
Skill names still come from each selected `SKILL.md`. `package.skills` must contain
at least one path; `package.notices` and `package.dependencies` are optional.
Paths in `skills` and `notices` are relative to the selected source directory
(repository root unless `subdir` is set), not your consumer's directory.

To resolve repository semver tags instead of pinning a ref, omit `source.ref`
and set `"version": "^1.2.0"` alongside `package`. The selected tag supplies the
package version; no upstream version field or manifest is required.

For a single-skill repository with `SKILL.md` at its root, use
`"package": {"skills": ["."]}`. Its exported name comes from that frontmatter.
Choose a source root that also contains the necessary licenses and resources.

### Manifest-aware packages (opt-in by dependency author)

Omit `package` to read the dependency's `skillpacker.json`:

```json
{
  "dependencies": {
    "writing-tools": {
      "source": {
        "type": "git",
        "url": "https://github.com/example/writing-tools.git"
      },
      "version": "^1.2.0"
    }
  }
}
```

This is a dependency fragment to place in your root manifest; the URL is illustrative.
Only this mode requires an upstream manifest. Its name must match the dependency key,
and its exports, version, and recursive dependencies come from that manifest.
If it is missing or malformed, resolution fails: there is no automatic fallback.

### Consumer-declared recursive dependencies

If a plain skill needs another skill, declare it in `package.dependencies` using
the same dependency syntax. Plain and manifest-aware dependencies can be mixed:

```json
{
  "source": { "type": "local", "path": "../writing-skills" },
  "package": {
    "skills": ["writing-coach"],
    "dependencies": {
      "style-tools": {
        "source": { "type": "local", "path": "../style-skills" },
        "package": { "skills": ["classic-style"] }
      }
    }
  }
}
```

This is one dependency declaration. Nested local source paths are relative to
the manifest that contains the declaration, **not** the fetched dependency.
Consumer metadata is explicit packaging input, not a mutation of upstream content.
It does not merge with an upstream manifest.

Without an upstream or consumer declaration, a plain source has **no declared
dependencies**, not a guarantee of self-containment. Skillpacker does not infer
dependency identities or versions from instructions, skill names, or URLs in prose.

### Sources and versioning

- **Git:** `{"type":"git","url":"https://…","subdir":"optional/package/path"}`.
  With no `ref`, a version range is required. Tags must be semver or `v`-prefixed
  semver. For manifest-aware packages, each tag's manifest version must match;
  for plain sources, the tag supplies the version. The version applies to the
  repository/package, not an independently versioned exported skill.
  Multiple tags representing the same version are rejected.
- **Exact Git ref:** add `"ref":"<commit, tag, or branch>"`. The selected commit
  is locked. Manifest-aware packages still require a version range matching the
  manifest version. Plain ref-pinned sources must omit `version` and record
  `version: null`, even when the ref happens to look like a version tag.
  To request semver resolution for plain sources, use a range without `ref`.
  Frozen builds use the locked commit, not the current branch/tag target.
  Retain locked commits on the server.
- **Local:** `{"type":"local","path":"../writing-tools"}`.
  Paths resolve relative to the declaring manifest. Local sources are intended for
  development. Plain local sources omit `version` and lock content hashes without
  inventing a semantic version. Their lock identities contain absolute paths and are not portable
  between machines. Use Git sources for shared locks and CI.
- Git URLs may use HTTPS, SSH (including `git@host:path`), or `file://`.
  Do not embed credentials. SSH can use an external SSH agent. System/global Git
  config is disabled for source operations to avoid inherited filters and hooks;
  credential helpers configured there are therefore not used.
- Local dependencies declared by an upstream Git manifest are rejected; use explicit
  Git references. Local dependencies in consumer-owned declarations are allowed and
  resolved relative to their declaring consumer manifest.
- npm semver ranges and prerelease semantics are provided by `semver`.

Unknown manifest and consumer-packaging fields are rejected rather than silently ignored.

### Conflict policy

One package name resolves to one source and one version or revision across the graph. Compatible
requirements are deduplicated. The resolver backtracks when the highest version
cannot satisfy the graph. It reports conflicting parent constraints when no solution
exists. Operational errors, such as authentication failures, abort resolution.

Consumer metadata must agree for every occurrence of a package identity.
Different selections, notices, nested dependencies, or plain/manifest modes for
the same identity fail with a packaging conflict rather than silently merging.
Different identities can select different skills from the same repository.
Cycles, incompatible sources, and duplicate exported skill names are errors.
There is no automatic renaming, side-by-side version installation, instruction
rewriting, or semantic conflict merging. Semver compatibility is an author claim,
not proof that two skills behave correctly together.

## Packaging contract

Each exported directory must have a valid `SKILL.md` with YAML `name` and
`description`; the name must match its directory, except for `"."` root selections.
The entire directory is copied,
including scripts, references, assets, and templates. Scripts are never executed by
Skillpacker. Symlinks and non-regular files in packaged content are rejected.
Git submodules and LFS downloads are not initialized.
Root skill selections exclude `.git`, `skillpacker.json`, and
`skillpacker.lock.json`; other root files are included, so select `"."` only when
the source root is a self-contained skill.

Keep required resources inside each skill directory. Skillpacker does not interpret
arbitrary prose, follow Markdown links, rewrite paths, or prove referenced resources
are complete. Missing **declared** skill and notice paths fail. Behavioral evaluation
and resource review remain release-author responsibilities.

Root `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `THIRD-PARTY-NOTICES` (including
file extensions), and the `LICENSES` directory are collected automatically.
Declare any additional notice files/directories in `notices`. These files are
preserved under each exported skill's `.skillpacker/notices/`, which is a reserved
directory. This records attribution but does not automatically determine whether
a license permits redistribution. Review each dependency's terms.

`skillpacker.provenance.json` records selected sources, versions (null for unversioned
plain sources), tags, commits, hashes, metadata origin, consumer packaging declarations,
exported skills, and notice paths. The lock records consumer metadata too; changing
that metadata requires a new resolution. Integrity covers the normalized manifest,
packaged file paths, contents, and executable flags. A hash detects changes relative
to the lock; it does not authenticate an author or make downloaded skills safe.

### Targets

| Target | Output |
| --- | --- |
| `portable` | `skills/<name>/…`, provenance, lockfile |
| `copilot` | Portable content plus root `plugin.json` |
| `claude` | Portable content plus `.claude-plugin/plugin.json` |

The plugin name/version come from the root manifest. These are plugin directories,
not marketplace catalogs. Publish the assembled directory to a Git branch/tag/path
that your marketplace points to, or install it using the host's local plugin support.
Uploading a CI artifact alone does not make it marketplace-installable.

Identical locked content produces identical file bytes and normalized executable
permissions on the same platform. File timestamps are not normalized and no archive
format is produced. Target hosts' actual runtime loading still needs host validation.

## Architecture and future standards

- `ManifestReader` in `src/model.ts` produces a normalized `Manifest`.
- `JsonManifestReader` owns the custom format and validation.
- The resolver consumes normalized requirements and a candidate `Provider`.
- `Sources` retrieves immutable Git snapshots or local development packages and
  constructs normalized manifests from explicit consumer packaging when supplied.
- Lock verification checks graph consistency and packaged content integrity.
- The bundler emits target-specific layout without executing dependency content.

Readers are injected through the library API; the CLI currently selects only the
v1 JSON reader. Tests exercise an alternate reader through resolution and bundling.
A future Agent Skills standard can be implemented as another reader. New semantics
may still require resolver/model changes; unsupported semantics must not be dropped.
Build targets and lockfiles remain separate from manifest syntax.

## Consumer CI

Developers run `resolve`, review dependency changes, and commit the manifest and
lockfile. CI runs `validate` and `build` without resolving. For a consumer using the
npm scripts above, a GitHub Actions job can run:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 24
      cache: npm
  - run: npm ci --include=dev
  - run: npm run skills:version
  - run: npm run skills:check
  - run: npm run skills:build
```

Run these steps from the directory containing the consumer's npm and Skillpacker
manifests. For a nested project, also set `working-directory` on the run steps and
`cache-dependency-path` on `setup-node`. GitHub-hosted runners provide Git; other
CI environments must install it.

Only a separate, authorized release step should publish that output. The CLI caches
Git mirrors/snapshots within one invocation and deletes them afterward. Persistent
cache management is not yet implemented.

## Releasing Skillpacker

[CI](.github/workflows/ci.yml) runs type checks, source tests, and installed-tarball
tests on Linux, macOS, and Windows using Node.js 20.19.0, 22, and 24.
It never publishes.

The [Release workflow](.github/workflows/release.yml) is manually dispatched on an
existing stable `vX.Y.Z` tag matching `package.json`. A branch or mismatched version
fails before packing. The workflow packs once and tests that same artifact across
the full OS/Node matrix. Its `publish` input defaults to `false`.
When a maintainer enables publication, the workflow waits for every test job and the
`npm` environment's approval rules, then publishes the tested tarball without
rebuilding or running package lifecycle scripts. This initial workflow rejects
prerelease tags so they cannot accidentally become npm's `latest`.

### One-time setup

1. Confirm that your npm account can publish under the `@willtsai` scope. Check the public registry
   with `npm view @willtsai/skillpacker name version --registry=https://registry.npmjs.org`.
   A missing package is not a reservation; authentication, permissions, and name
   restrictions still apply. Do not treat network or authentication failures as
   proof of availability.
2. Enable two-factor authentication for the npm owner account.
3. Create the GitHub environment **npm**, configure required reviewers, and allow
   release tags. Ensure an authorized maintainer can approve its jobs. Merely naming
   an environment in a workflow does not configure an approval gate.
4. Merge these workflows to the default branch before dispatching a release.
   Keep release tags immutable and restrict who can create them.

### First publication (completed)

Version 0.1.1 was published as `@willtsai/skillpacker` after the
[release verification matrix](https://github.com/willtsai/skillpacker/actions/runs/40638897440)
passed. The first publication used interactive npm authentication and the exact
CI-tested tarball; it does not provide GitHub Actions OIDC provenance.
The existing `v0.1.0` tag
and its tarball describe the unscoped package; do not move that tag or publish
that artifact.

To verify the published version and install it in a clean consumer:

```sh
npm view @willtsai/skillpacker@0.1.1 version dist.integrity --registry=https://registry.npmjs.org
npm install --save-dev --save-exact @willtsai/skillpacker@0.1.1 --registry=https://registry.npmjs.org
npm exec -- skillpacker --version
```

Run the install commands in that consumer, not the Skillpacker checkout.
Do not run the publish-enabled workflow for a version already published:
npm versions cannot be replaced.

### Subsequent publications

Do not add a long-lived npm token to this repository or its workflows.
In the npm settings for `@willtsai/skillpacker`, configure
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
GitHub owner `willtsai`, repository `skillpacker`, workflow `release.yml`, and
environment `npm`. The publish job uses a GitHub-hosted Node.js 24 runner and its
OIDC-capable npm CLI, with `id-token: write`; it needs no `NPM_TOKEN`. npm generates
provenance for eligible public-source trusted publishes.

Configure the connection shortly before using it: npm currently requires its first
successful publish within two days or the unvalidated configuration expires.
After verifying OIDC publication, restrict traditional publishing-token access in
npm's package settings.

Check production dependencies for known advisories before tagging, and resolve
reported vulnerabilities before publishing:

```sh
npm audit --omit=dev
```

For each release, update the version in `package.json` and `package-lock.json`,
review user-visible changes and compatibility, run CI, and commit and tag the result.
Dispatch Release on that tag with `publish=true` and approve the environment job.
For example, after preparing and pushing a matching `v0.1.2` tag:

```sh
gh workflow run release.yml --ref v0.1.2 -f publish=true
```

Verify the registry install, provenance, and CLI version before announcing success.
If validation or publication fails, inspect the failed step; do not suppress errors
or silently skip an existing version. For a bad published release, publish a new
patch and deprecate the affected version with an actionable message rather than
moving its tag or trying to overwrite it.

## Current limits and next steps

- Plain sources need explicit consumer skill selections; no automatic dependency
  inference, adapter registry, or standard dependency fields yet.
- Resolver refreshes the whole graph; no targeted `add`/`update`, overrides, or optional dependencies.
- Backtracking is intended for small skill graphs; no solver budget or large-graph optimization yet.
- No registry, hosted service, automatic install into hosts, or publishing command.
- No behavioral compatibility evaluation or cryptographic signature verification.
- Git sources must remain reachable for frozen builds; there is no offline cache.

The initial goal is a tested, reusable resolver/bundler foundation, not a claim of
full npm parity. Product Cabinet-specific policies are not embedded in the core.

## License

MIT. Bundled dependencies retain their own licenses.
