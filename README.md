# Skillpacker

**Dependency resolution and reproducible bundling for agent skills.**

Skillpacker is a local-first CLI that also runs in CI. Declare packages of skills,
resolve their recursive dependencies, lock exact Git commits and content hashes,
and assemble self-contained portable, Copilot, or Claude Code bundles.

This is an initial implementation, not a published npm package. The npm name has
not been reserved or checked for availability. Publication is disabled with
`private: true` until a release is ready.

## Requirements and development installation

- Node.js 20.19 or later
- npm
- Git with access to your dependency repositories

```sh
npm ci
npm test
node dist/src/cli.js --help
```

Optionally run `npm link` to expose `skillpacker` locally. Nothing is installed
into an agent host automatically.

## Try the included example

The example has a root skill and a separate local skill source with **no
Skillpacker manifest**. The consumer selects what to bundle:

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

## CI and release workflow

Developers run `resolve`, review dependency changes, and commit the manifest and
lockfile. CI runs `validate` and `build` without resolving. The included GitHub Actions
workflow runs type checks and tests on Linux, macOS, and Windows. It does not publish.

For a real bundle project after installing a pinned Skillpacker release:

```sh
skillpacker validate
skillpacker build --target claude --out bundles/claude-release
```

Only a separate, authorized release step should publish that output. The CLI caches
Git mirrors/snapshots within one invocation and deletes them afterward. Persistent
cache management is not yet implemented.

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
