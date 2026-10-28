import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this test through npm run test:package");

test("the npm tarball works in an isolated consumer without compilation", { timeout: 180_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "skillpacker-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  const npm = (args, cwd = consumer) => exec(process.execPath, [npmCli, ...args], {
    cwd, env: { ...process.env, NODE_PATH: "" }, timeout: 120_000
  });
  let tarball = process.env.SKILLPACKER_TARBALL;
  if (tarball) {
    tarball = path.resolve(tarball);
    await access(tarball);
  } else {
    await npm(["pack", "--pack-destination", temporary], project);
    tarball = path.join(temporary, `willtsai-skillpacker-${metadata.version}.tgz`);
  }
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    name: "skillpacker-package-test", private: true, type: "module",
    scripts: { skillpacker: "skillpacker" }
  }));
  await npm(["install", "--save-dev", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const installed = path.join(consumer, "node_modules", "@willtsai", "skillpacker");

  await t.test("contains compiled entry points, declarations, and notices but no development files", async () => {
    const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    assert.equal(pkg.name, "@willtsai/skillpacker");
    assert.equal(pkg.version, metadata.version);
    assert.notEqual(pkg.private, true);
    assert.equal(pkg.publishConfig.access, "public");
    assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org");
    for (const file of [pkg.bin.skillpacker, pkg.exports, pkg.types, "README.md", "LICENSE"]) {
      await access(path.join(installed, file));
    }
    for (const file of ["src", "test", "dist/test", "scripts", "examples", "tsconfig.json"]) {
      await assert.rejects(access(path.join(installed, file)), { code: "ENOENT" });
    }
    for (const dependency of ["typescript", "@types/node", "@types/semver"]) {
      await assert.rejects(access(path.join(consumer, "node_modules", dependency)), { code: "ENOENT" });
    }
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.equal(pkg.scripts[hook], undefined);
    }
    assert.match(await readFile(path.join(installed, pkg.bin.skillpacker), "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
  });

  await t.test("can publish the tarball from an artifact-only directory in dry-run mode", async () => {
    const publisher = path.join(temporary, "publisher");
    await mkdir(path.join(publisher, "release"), { recursive: true });
    await cp(tarball, path.join(publisher, "release", "willtsai-skillpacker.tgz"));
    const { stdout } = await npm([
      "publish", "./release/willtsai-skillpacker.tgz", "--dry-run", "--json",
      "--access", "public", "--ignore-scripts", "--registry=https://registry.npmjs.org"
    ], publisher);
    const published = JSON.parse(stdout);
    assert.equal(published.name, "@willtsai/skillpacker");
    assert.equal(published.version, metadata.version);
  });

  const cli = (...args) => npm(["run", "--silent", "skillpacker", "--", ...args]);
  const failure = pattern => error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, pattern);
    return true;
  };
  await t.test("exposes a working command shim and ESM library", async () => {
    assert.match((await cli("--help")).stdout, /Usage:/);
    assert.equal((await cli("--version")).stdout.trim(), metadata.version);
    await exec(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import * as api from "@willtsai/skillpacker";
      for (const name of ["JsonManifestReader", "Sources", "resolveGraph", "resolveLock", "verifyLock", "buildBundle"]) {
        assert.equal(typeof api[name], "function", name);
      }
    `], { cwd: consumer, env: { ...process.env, NODE_PATH: "" } });
    await assert.rejects(cli("unknown"), failure(/skillpacker: Unknown command/));
  });

  await t.test("reinstalls from the consumer lockfile with npm ci", async () => {
    const lock = await readFile(path.join(consumer, "package-lock.json"), "utf8");
    await npm(["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
    assert.equal((await cli("--version")).stdout.trim(), metadata.version);
    assert.equal(await readFile(path.join(consumer, "package-lock.json"), "utf8"), lock);
  });

  await cp(path.join(project, "examples"), path.join(consumer, "examples"), { recursive: true });
  const root = path.join(consumer, "examples", "demo");
  await t.test("resolves plain skills and produces all targets from a frozen lock", async () => {
    await cli("resolve", "--cwd", root);
    await cli("validate", "--cwd", root);
    const lock = await readFile(path.join(root, "skillpacker.lock.json"), "utf8");
    for (const target of ["portable", "copilot", "claude"]) {
      const output = path.join(consumer, target);
      await cli("build", "--cwd", root, "--target", target, "--out", output);
      assert.deepEqual((await readdir(path.join(output, "skills"))).sort(), ["demo-ceo", "demo-writing-review"]);
      await access(path.join(output, "skills/demo-writing-review/.skillpacker/notices/LICENSE"));
      await access(path.join(output, "skillpacker.provenance.json"));
      assert.equal(await readFile(path.join(output, "skillpacker.lock.json"), "utf8"), lock);
      if (target !== "portable") {
        const manifest = target === "copilot" ? "plugin.json" : ".claude-plugin/plugin.json";
        assert.equal(JSON.parse(await readFile(path.join(output, manifest), "utf8")).name, "demo-cabinet");
      }
      await assert.rejects(cli("build", "--cwd", root, "--target", target, "--out", output),
        failure(/skillpacker: Output already exists:/));
    }
    assert.equal(await readFile(path.join(root, "skillpacker.lock.json"), "utf8"), lock);
  });

  await t.test("fails frozen operations on changed content without repairing the lock", async () => {
    const lock = await readFile(path.join(root, "skillpacker.lock.json"), "utf8");
    const skill = path.join(root, "skills/demo-ceo/SKILL.md");
    await writeFile(skill, (await readFile(skill, "utf8")) + "\nChanged after locking.\n");
    await assert.rejects(cli("validate", "--cwd", root), failure(/skillpacker: Root content changed/));
    await assert.rejects(cli("build", "--cwd", root, "--out", path.join(consumer, "stale")),
      failure(/skillpacker: Root content changed/));
    assert.equal(await readFile(path.join(root, "skillpacker.lock.json"), "utf8"), lock);
    await assert.rejects(access(path.join(consumer, "stale")), { code: "ENOENT" });
  });
});
