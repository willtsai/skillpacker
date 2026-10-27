import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonManifestReader } from "../src/manifest.js";
import { Sources } from "../src/sources.js";
import { resolveLock, verifyLock, writeJson } from "../src/lock.js";
import { buildBundle } from "../src/bundle.js";
import { filesUnder } from "../src/files.js";
import type { Manifest } from "../src/model.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "skillpacker-test-"));
  const reader = new JsonManifestReader();
  const sources = await Sources.create(reader);
  t.after(async () => { await sources.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, reader, sources };
}
async function pkg(directory: string, name: string, skills = [name], dependencies: unknown = {}, version = "1.0.0") {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "skillpacker.json"), JSON.stringify({
    schemaVersion: 1, name, version, skills: skills.map(s => `skills/${s}`), dependencies
  }));
  for (const skill of skills) {
    await mkdir(path.join(directory, "skills", skill, "references"), { recursive: true });
    await writeFile(path.join(directory, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: A test skill\n---\nRead references/guide.md.\n`);
    await writeFile(path.join(directory, "skills", skill, "references", "guide.md"), "A guide\n");
  }
  await writeFile(path.join(directory, "LICENSE"), "Fixture license\n");
}
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-c", "user.name=Skillpacker Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
}
async function tag(cwd: string, version: string) {
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", version);
  await git(cwd, "tag", `v${version}`);
}

test("CLI init does not overwrite an existing manifest and invalid options fail", async t => {
  const { directory } = await setup(t);
  await exec(process.execPath, [cli, "init", "--cwd", directory, "--name", "sample"]);
  await assert.rejects(exec(process.execPath, [cli, "init", "--cwd", directory, "--name", "sample"]), /EEXIST/);
  await assert.rejects(exec(process.execPath, [cli, "resolve", "--target", "claude"]), /Options do not apply/);
  await assert.rejects(exec(process.execPath, [cli, "unknown"]), /Unknown command/);
});

test("real CLI resolve, validate, and build work end to end", async t => {
  const { directory } = await setup(t);
  await pkg(directory, "demo");
  for (const command of ["resolve", "validate"]) {
    await exec(process.execPath, [cli, command, "--cwd", directory]);
  }
  await exec(process.execPath, [cli, "build", "--cwd", directory, "--target", "copilot", "--out", "output"]);
  const plugin = JSON.parse(await readFile(path.join(directory, "output", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "demo");
});

test("Git tags resolve recursively; frozen build ignores newer tags and emits reproducible targets", async t => {
  const { directory, reader, sources } = await setup(t);
  const common = path.join(directory, "common");
  await pkg(common, "common");
  await git(common, "init");
  await tag(common, "1.0.0");
  const dependency = { source: { type: "git", url: pathToFileURL(common).href }, version: "^1.0.0" };
  const external = path.join(directory, "external");
  await pkg(external, "external", ["external"], { common: dependency });
  await git(external, "init");
  await tag(external, "1.0.0");
  await pkg(external, "external", ["external"], { common: dependency }, "1.2.0");
  await tag(external, "1.2.0");
  const root = path.join(directory, "root");
  await pkg(root, "demo", ["demo"], {
    external: { source: { type: "git", url: pathToFileURL(external).href }, version: "^1" }
  });
  const lock = await resolveLock(root, reader, sources);
  assert.equal(lock.packages.external?.manifest.version, "1.2.0");
  assert.equal(lock.packages.common?.manifest.version, "1.0.0");
  assert.match(lock.packages.external!.revision!, /^[a-f0-9]{40}$/);
  await writeJson(path.join(root, "skillpacker.lock.json"), lock);
  await pkg(external, "external", ["external"], { common: dependency }, "1.3.0");
  await tag(external, "1.3.0");
  const frozen = await Sources.create(reader);
  t.after(() => frozen.close());
  for (const target of ["portable", "copilot", "claude"] as const) {
    const out = path.join(directory, target);
    const second = path.join(directory, `${target}-second`);
    await buildBundle(root, out, target, reader, frozen);
    await buildBundle(root, second, target, reader, frozen);
    assert.deepEqual((await readdir(path.join(out, "skills"))).sort(), ["common", "demo", "external"]);
    for (const file of await filesUnder(directory, target)) {
      const relative = file.slice(target.length + 1);
      assert.deepEqual(await readFile(path.join(out, relative)), await readFile(path.join(second, relative)));
    }
    assert.equal(await readFile(path.join(out, "skills", "external", ".skillpacker", "notices", "LICENSE"), "utf8"), "Fixture license\n");
    const provenance = JSON.parse(await readFile(path.join(out, "skillpacker.provenance.json"), "utf8"));
    assert.equal(provenance.find((p: { package: string }) => p.package === "external").version, "1.2.0");
    await assert.rejects(buildBundle(root, out, target, reader, frozen), /already exists/);
  }
});

test("local dependency tampering and stale root manifests fail frozen verification", async t => {
  const { directory, reader, sources } = await setup(t);
  const dep = path.join(directory, "dependency");
  const root = path.join(directory, "root");
  await pkg(dep, "external");
  await pkg(root, "demo", ["demo"], {
    external: { source: { type: "local", path: "../dependency" }, version: "^1" }
  });
  await writeJson(path.join(root, "skillpacker.lock.json"), await resolveLock(root, reader, sources));
  await writeFile(path.join(dep, "skills", "external", "references", "guide.md"), "Modified");
  await assert.rejects(verifyLock(root, reader, sources), /Integrity mismatch/);
  await pkg(root, "demo", ["demo"], {}, "2.0.0");
  await assert.rejects(verifyLock(root, reader, sources), /Root manifest changed/);
});

test("colliding exported skills fail without publishing output", async t => {
  const { directory, reader, sources } = await setup(t);
  const dep = path.join(directory, "dependency");
  const root = path.join(directory, "root");
  await pkg(dep, "external", ["shared"]);
  await pkg(root, "demo", ["shared"], {
    external: { source: { type: "local", path: "../dependency" }, version: "*" }
  });
  await writeJson(path.join(root, "skillpacker.lock.json"), await resolveLock(root, reader, sources));
  await assert.rejects(buildBundle(root, path.join(directory, "output"), "portable", reader, sources), /collision/);
  assert(!(await readdir(directory)).includes("output"));
});

test("manifest traversal, unknown fields and missing skill resources are rejected", async t => {
  const { directory, reader, sources } = await setup(t);
  await writeFile(path.join(directory, "skillpacker.json"), JSON.stringify({
    schemaVersion: 1, name: "demo", version: "1.0.0", skills: ["../outside"]
  }));
  await assert.rejects(reader.read(directory), /relative path/);
  await writeFile(path.join(directory, "skillpacker.json"), JSON.stringify({
    schemaVersion: 1, name: "demo", version: "1.0.0", dependency: {}
  }));
  await assert.rejects(reader.read(directory), /Unrecognized key/);
  await pkg(directory, "demo");
  await rm(path.join(directory, "skills", "demo", "SKILL.md"));
  await assert.rejects(resolveLock(directory, reader, sources), /ENOENT/);
});

test("symlink resources are rejected", { skip: process.platform === "win32" }, async t => {
  const { directory, reader, sources } = await setup(t);
  await pkg(directory, "demo");
  await symlink(path.join(directory, "LICENSE"), path.join(directory, "skills", "demo", "linked-license"));
  await assert.rejects(resolveLock(directory, reader, sources), /Symlinks/);
});

test("git subdirectories and exact refs are supported", async t => {
  const { directory, reader, sources } = await setup(t);
  const repository = path.join(directory, "repo");
  await pkg(path.join(repository, "packages", "external"), "external");
  await git(repository, "init");
  await tag(repository, "1.0.0");
  const revision = await git(repository, "rev-parse", "HEAD");
  const root = path.join(directory, "root");
  await pkg(root, "demo", ["demo"], {
    external: { source: { type: "git", url: pathToFileURL(repository).href, subdir: "packages/external", ref: revision }, version: "^1" }
  });
  const lock = await resolveLock(root, reader, sources);
  assert.equal(lock.packages.external?.revision, revision);
});

test("alternate manifest readers can feed the same resolver and bundler", async t => {
  const { directory } = await setup(t);
  await pkg(directory, "demo");
  const normalized: Manifest = { name: "demo", version: "1.0.0", skills: ["skills/demo"], dependencies: {}, notices: [] };
  const reader = { async read() { return normalized; } };
  const sources = await Sources.create(reader);
  t.after(() => sources.close());
  await writeJson(path.join(directory, "skillpacker.lock.json"), await resolveLock(directory, reader, sources));
  await buildBundle(directory, path.join(directory, "output"), "portable", reader, sources);
  assert.equal((await verifyLock(directory, reader, sources))[0]?.manifest.name, "demo");
});

test("malformed locks and modified root content fail rather than resolving implicitly", async t => {
  const { directory, reader, sources } = await setup(t);
  await pkg(directory, "demo");
  const lock = await resolveLock(directory, reader, sources);
  const filename = path.join(directory, "skillpacker.lock.json");
  await writeJson(filename, { ...lock, lockVersion: 99 });
  await assert.rejects(verifyLock(directory, reader, sources), /Invalid literal/);
  await writeJson(filename, lock);
  await writeFile(path.join(directory, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: changed\n---\nChanged instructions.");
  await assert.rejects(verifyLock(directory, reader, sources), /Root content changed/);
});

test("bundling cannot write into skill directories", async t => {
  const { directory, reader, sources } = await setup(t);
  await pkg(directory, "demo");
  await writeJson(path.join(directory, "skillpacker.lock.json"), await resolveLock(directory, reader, sources));
  await assert.rejects(buildBundle(
    directory, path.join(directory, "skills", "demo", "generated"), "portable", reader, sources
  ), /inside packaged resources/);
});

test("missing declared notices fail", async t => {
  const { directory, reader, sources } = await setup(t);
  await pkg(directory, "demo");
  const filename = path.join(directory, "skillpacker.json");
  const data = JSON.parse(await readFile(filename, "utf8"));
  await writeJson(filename, { ...data, notices: ["missing-notice.txt"] });
  await assert.rejects(resolveLock(directory, reader, sources), /ENOENT/);
});

test("executable scripts are copied without executing them", { skip: process.platform === "win32" }, async t => {
  const { directory, reader, sources } = await setup(t);
  await pkg(directory, "demo");
  const script = path.join(directory, "skills", "demo", "script.sh");
  const content = "#!/bin/sh\nexit 99\n";
  await writeFile(script, content);
  await chmod(script, 0o755);
  await writeJson(path.join(directory, "skillpacker.lock.json"), await resolveLock(directory, reader, sources));
  const out = path.join(directory, "output");
  await buildBundle(directory, out, "portable", reader, sources);
  const copied = path.join(out, "skills", "demo", "script.sh");
  assert.equal((await lstat(copied)).mode & 0o777, 0o755);
  assert.equal(await readFile(copied, "utf8"), content);
});

test("Git tag versions must agree with package versions", async t => {
  const { directory, reader, sources } = await setup(t);
  const repo = path.join(directory, "repo");
  await pkg(repo, "external", ["external"], {}, "1.0.0");
  await git(repo, "init");
  await tag(repo, "2.0.0");
  await assert.rejects(sources.candidates({ type: "git", url: pathToFileURL(repo).href, subdir: "" }),
    /disagrees with manifest version/);
});

test("plain Git ref sources need no manifest, preserve resources, and stay frozen after upstream changes", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "unused", ["writing-coach", "not-selected"]);
  await rm(path.join(upstream, "skillpacker.json"));
  await git(upstream, "init", "-b", "main");
  await tag(upstream, "1.0.0");
  const commit = await git(upstream, "rev-parse", "HEAD");
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", ["cabinet"], {
    "writing-tools": {
      source: { type: "git", url: pathToFileURL(upstream).href, ref: "main" },
      package: { skills: ["skills/writing-coach"], notices: ["LICENSE"] }
    }
  });
  const lock = await resolveLock(root, reader, sources);
  assert.equal(lock.packages["writing-tools"]?.revision, commit);
  assert.equal(lock.packages["writing-tools"]?.manifest.version, null);
  assert.equal(lock.packages["writing-tools"]?.tag, undefined);
  await writeJson(path.join(root, "skillpacker.lock.json"), lock);
  // The consumer's explicit selection must not change when upstream adds a manifest.
  await writeFile(path.join(upstream, "skillpacker.json"), "not even valid JSON");
  await writeFile(path.join(upstream, "skills/writing-coach/references/guide.md"), "New guide");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "change upstream");
  const frozen = await Sources.create(reader);
  t.after(() => frozen.close());
  for (const target of ["portable", "copilot", "claude"] as const) {
    const output = path.join(directory, target);
    await buildBundle(root, output, target, reader, frozen);
    assert.deepEqual((await readdir(path.join(output, "skills"))).sort(), ["cabinet", "writing-coach"]);
    assert.equal(await readFile(path.join(output, "skills/writing-coach/references/guide.md"), "utf8"), "A guide\n");
    assert.equal(await readFile(path.join(output, "skills/writing-coach/.skillpacker/notices/LICENSE"), "utf8"), "Fixture license\n");
    const provenance = JSON.parse(await readFile(path.join(output, "skillpacker.provenance.json"), "utf8"));
    const entry = provenance.find((p: { package: string }) => p.package === "writing-tools");
    assert.equal(entry.version, null);
    assert.equal(entry.metadataOrigin, "consumer");
  }
  const refreshed = await resolveLock(root, reader, frozen);
  assert.notEqual(refreshed.packages["writing-tools"]?.revision, commit);
  assert.deepEqual(refreshed.packages["writing-tools"]?.manifest.skills, ["skills/writing-coach"]);
});

test("plain semver-tag packages resolve versions and consumer-declared recursive mixed dependencies", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "unused", ["external"]);
  await rm(path.join(upstream, "skillpacker.json"));
  await git(upstream, "init");
  await tag(upstream, "1.0.0");
  await writeFile(path.join(upstream, "skills/external/references/guide.md"), "Version 1.2");
  await tag(upstream, "1.2.0");
  const native = path.join(directory, "native");
  await pkg(native, "native");
  const helper = path.join(directory, "helper");
  await pkg(helper, "unused", ["helper"]);
  await rm(path.join(helper, "skillpacker.json"));
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    external: {
      source: { type: "git", url: pathToFileURL(upstream).href },
      version: "^1",
      package: {
        skills: ["skills/external"],
        dependencies: {
          native: { source: { type: "local", path: "../native" }, version: "^1" },
          helper: {
            source: { type: "local", path: "../helper" },
            package: { skills: ["skills/helper"] }
          }
        }
      }
    }
  });
  const lock = await resolveLock(root, reader, sources);
  assert.equal(lock.packages.external?.manifest.version, "1.2.0");
  assert.equal(lock.packages.external?.tag, "v1.2.0");
  assert.equal(lock.packages.helper?.manifest.version, null);
  assert.equal(lock.packages.native?.manifest.version, "1.0.0");
  await writeJson(path.join(root, "skillpacker.lock.json"), lock);
  // A frozen build uses the commit, even if the upstream version tag moves.
  await git(upstream, "tag", "-f", "v1.2.0", "v1.0.0");
  const frozen = await Sources.create(reader);
  t.after(() => frozen.close());
  const output = path.join(directory, "out");
  await buildBundle(root, output, "portable", reader, frozen);
  assert.deepEqual((await readdir(path.join(output, "skills"))).sort(), ["external", "helper", "native"]);
  assert.equal(await readFile(path.join(output, "skills/external/references/guide.md"), "utf8"), "Version 1.2");
});

test("plain local sources ignore upstream metadata and detect content and packaging changes", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "external");
  await writeFile(path.join(upstream, "skillpacker.json"), "invalid and intentionally ignored");
  const root = path.join(directory, "root");
  const dependencies = {
    external: { source: { type: "local", path: "../upstream" }, package: { skills: ["skills/external"] } }
  };
  await pkg(root, "cabinet", [], dependencies);
  const lock = await resolveLock(root, reader, sources);
  const filename = path.join(root, "skillpacker.lock.json");
  await writeJson(filename, lock);
  await verifyLock(root, reader, sources);
  await writeFile(path.join(upstream, "skills/external/references/guide.md"), "tampered");
  await assert.rejects(verifyLock(root, reader, sources), /Integrity mismatch/);
  await writeFile(path.join(upstream, "skills/external/references/guide.md"), "A guide\n");
  await pkg(root, "cabinet", [], {
    external: { ...dependencies.external, package: { skills: ["skills/external"], notices: ["LICENSE"] } }
  });
  await assert.rejects(verifyLock(root, reader, sources), /Root manifest changed/);
});

test("consumer metadata conflicts and manifest/plain mode conflicts fail explicitly", async t => {
  const { directory, reader, sources } = await setup(t);
  const external = path.join(directory, "external");
  await pkg(external, "external", ["one", "two"]);
  const middle = path.join(directory, "middle");
  const externalSource = { type: "local", path: "../external" };
  await pkg(middle, "middle", [], {
    external: { source: externalSource, package: { skills: ["skills/two"] } }
  });
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    external: { source: externalSource, package: { skills: ["skills/one"] } },
    middle: { source: { type: "local", path: "../middle" }, version: "^1" }
  });
  await assert.rejects(resolveLock(root, reader, sources), /Packaging conflict/);
  await pkg(root, "cabinet", [], {
    external: { source: externalSource, version: "^1" },
    middle: { source: { type: "local", path: "../middle" }, version: "^1" }
  });
  const fresh = await Sources.create(reader);
  t.after(() => fresh.close());
  await assert.rejects(resolveLock(root, reader, fresh), /Packaging conflict/);
});

test("plain mode schema requires an explicit selector and rejects ambiguous versions and path escapes", async t => {
  const { directory, reader } = await setup(t);
  const invalid = [
    { source: { type: "git", url: "https://example.invalid/repo.git" }, package: { skills: ["skills/one"] } },
    { source: { type: "git", url: "https://example.invalid/repo.git", ref: "main" }, version: "^1", package: { skills: ["skills/one"] } },
    { source: { type: "local", path: "../external" }, version: "*", package: { skills: ["skills/one"] } },
    { source: { type: "local", path: "../external" }, package: { skills: ["../one"] } },
    { source: { type: "local", path: "../external" }, package: { skills: ["one"], notices: ["../LICENSE"] } },
    { source: { type: "local", path: "../external" }, package: { skills: ["one"], extra: true } },
    { source: { type: "local", path: "../external" }, package: { skills: [] } }
  ];
  for (const declaration of invalid) {
    await pkg(directory, "cabinet", [], { external: declaration });
    await assert.rejects(reader.read(directory));
  }
});

test("missing consumer-declared resources fail, while omitted package still requires an upstream manifest", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "external");
  await rm(path.join(upstream, "skillpacker.json"));
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    external: { source: { type: "local", path: "../upstream" }, version: "^1" }
  });
  await assert.rejects(resolveLock(root, reader, sources), /skillpacker.json/);
  for (const definition of [
    { skills: ["missing"] }, { skills: ["skills/external"], notices: ["missing-notice"] }
  ]) {
    await pkg(root, "cabinet", [], {
      external: { source: { type: "local", path: "../upstream" }, package: definition }
    });
    const fresh = await Sources.create(reader);
    try { await assert.rejects(resolveLock(root, reader, fresh), /ENOENT/); } finally { await fresh.close(); }
  }
});

test("single-skill repository roots can be selected without shipping Git internals", async t => {
  const { directory, reader, sources } = await setup(t);
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "SKILL.md"), "---\nname: single-skill\ndescription: A root skill\n---\nUse references/guide.md.\n");
  await mkdir(path.join(repo, "references"));
  await writeFile(path.join(repo, "references/guide.md"), "Root guide");
  await writeFile(path.join(repo, "LICENSE"), "Root license");
  await git(repo, "init");
  await tag(repo, "1.0.0");
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    external: {
      source: { type: "git", url: pathToFileURL(repo).href, ref: "v1.0.0" },
      package: { skills: ["."] }
    }
  });
  await writeJson(path.join(root, "skillpacker.lock.json"), await resolveLock(root, reader, sources));
  const output = path.join(directory, "out");
  await buildBundle(root, output, "portable", reader, sources);
  assert.deepEqual((await readdir(path.join(output, "skills/single-skill"))).sort(),
    [".skillpacker", "LICENSE", "SKILL.md", "references"]);
  assert.equal(await readFile(path.join(output, "skills/single-skill/references/guide.md"), "utf8"), "Root guide");
});

test("frozen verification rejects changed lock packaging or tag version", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "unused", ["external"]);
  await rm(path.join(upstream, "skillpacker.json"));
  await git(upstream, "init");
  await tag(upstream, "1.0.0");
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    external: {
      source: { type: "git", url: pathToFileURL(upstream).href },
      version: "^1", package: { skills: ["skills/external"] }
    }
  });
  const lock = await resolveLock(root, reader, sources);
  const filename = path.join(root, "skillpacker.lock.json");
  const changedPackaging = structuredClone(lock);
  changedPackaging.packages.external!.package = {
    ...changedPackaging.packages.external!.package!, skills: ["other"]
  };
  await writeJson(filename, changedPackaging);
  await assert.rejects(verifyLock(root, reader, sources), /Locked manifest mismatch/);
  const changedTag = structuredClone(lock);
  changedTag.packages.external!.tag = "v1.9.0";
  await writeJson(filename, changedTag);
  await assert.rejects(verifyLock(root, reader, sources), /Locked manifest mismatch/);
  const missingTag = structuredClone(lock);
  delete missingTag.packages.external!.tag;
  await writeJson(filename, missingTag);
  await assert.rejects(verifyLock(root, reader, sources), /selected semver tag/);
});

test("different package identities can select distinct skills from the same Git snapshot", async t => {
  const { directory, reader, sources } = await setup(t);
  const upstream = path.join(directory, "upstream");
  await pkg(upstream, "unused", ["one", "two"]);
  await rm(path.join(upstream, "skillpacker.json"));
  await git(upstream, "init");
  await tag(upstream, "1.0.0");
  const source = { type: "git", url: pathToFileURL(upstream).href, ref: "v1.0.0" };
  const root = path.join(directory, "root");
  await pkg(root, "cabinet", [], {
    first: { source, package: { skills: ["skills/one"] } },
    second: { source, package: { skills: ["skills/two"] } }
  });
  const lock = await resolveLock(root, reader, sources);
  assert.equal(lock.packages.first?.manifest.name, "first");
  assert.equal(lock.packages.second?.manifest.name, "second");
  await writeJson(path.join(root, "skillpacker.lock.json"), lock);
  const output = path.join(directory, "out");
  await buildBundle(root, output, "portable", reader, sources);
  assert.deepEqual((await readdir(path.join(output, "skills"))).sort(), ["one", "two"]);
});

test("the shipped example resolves and builds through the CLI without modifying upstream skills", async t => {
  const { directory } = await setup(t);
  // Compiled tests live under dist/test; the source examples remain at repo root.
  const source = fileURLToPath(new URL("../../examples", import.meta.url));
  await cp(source, path.join(directory, "examples"), { recursive: true });
  const root = path.join(directory, "examples/demo");
  const upstream = path.join(directory, "examples/writing");
  assert(!(await readdir(upstream)).includes("skillpacker.json"));
  for (const command of ["resolve", "validate"]) {
    await exec(process.execPath, [cli, command, "--cwd", root]);
  }
  await exec(process.execPath, [cli, "build", "--cwd", root, "--target", "copilot", "--out", "../../out"]);
  assert.deepEqual((await readdir(path.join(directory, "out/skills"))).sort(), ["demo-ceo", "demo-writing-review"]);
  assert(!(await readdir(upstream)).includes("skillpacker.json"));
});
