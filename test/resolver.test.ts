import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGraph } from "../src/resolver.js";
import type { Candidate, Manifest, Provider, Requirement } from "../src/model.js";

function manifest(name: string, version: string, dependencies: Record<string, Requirement> = {}): Manifest {
  return { name, version, dependencies, skills: [], notices: [] };
}
function dep(name: string, range: string): Requirement {
  return { range, source: { type: "local", path: `/${name}` } };
}
function provider(manifests: Manifest[]): Provider {
  return {
    async candidates(source) {
      assert.equal(source.type, "local");
      return manifests.filter(m => source.type === "local" && source.path === `/${m.name}`)
        .map(m => ({ source, directory: `/${m.name}`, manifest: m } satisfies Candidate));
    }
  };
}

test("backtracks to the highest compatible solution and deduplicates a diamond", async () => {
  const root = manifest("root", "1.0.0", { alpha: dep("alpha", "*"), beta: dep("beta", "*") });
  const result = await resolveGraph(root, provider([
    manifest("alpha", "2.0.0", { common: dep("common", "^2") }),
    manifest("alpha", "1.0.0", { common: dep("common", "^1") }),
    manifest("beta", "1.0.0", { common: dep("common", "^1") }),
    manifest("common", "2.0.0"), manifest("common", "1.2.0"), manifest("common", "1.1.0")
  ]));
  assert.equal(result.alpha?.manifest.version, "1.0.0");
  assert.equal(result.common?.manifest.version, "1.2.0");
  assert.equal(Object.keys(result).length, 3);
});

test("incompatible ranges explain parent constraints", async () => {
  const root = manifest("root", "1.0.0", { alpha: dep("alpha", "*"), beta: dep("beta", "*") });
  await assert.rejects(resolveGraph(root, provider([
    manifest("alpha", "1.0.0", { common: dep("common", "^2") }),
    manifest("beta", "1.0.0", { common: dep("common", "^1") }),
    manifest("common", "2.0.0")
  ])), /alpha requires \^2; beta requires \^1/);
});

test("recursive cycles are rejected", async () => {
  await assert.rejects(resolveGraph(manifest("root", "1.0.0", { alpha: dep("alpha", "*") }), provider([
    manifest("alpha", "1.0.0", { beta: dep("beta", "*") }),
    manifest("beta", "1.0.0", { alpha: dep("alpha", "*") })
  ])), /cycle.*alpha -> beta -> alpha/);
});

test("same package identity with distinct sources is a conflict", async () => {
  await assert.rejects(resolveGraph(manifest("root", "1.0.0", {
    alpha: dep("alpha", "*"), beta: dep("beta", "*")
  }), provider([
    manifest("alpha", "1.0.0", { common: dep("common", "*") }),
    manifest("beta", "1.0.0", { common: { range: "*", source: { type: "local", path: "/different" } } })
  ])), /Source conflict/);
});

test("operational failures are not interpreted as solvable conflicts", async () => {
  await assert.rejects(resolveGraph(manifest("root", "1.0.0", { alpha: dep("alpha", "*") }), {
    async candidates() { throw new Error("Network unavailable"); }
  }), /^Error: Network unavailable$/);
});

test("prerelease candidates require a matching prerelease constraint", async () => {
  const candidates = provider([manifest("alpha", "2.0.0-beta.1"), manifest("alpha", "1.0.0")]);
  const stable = await resolveGraph(manifest("root", "1.0.0", { alpha: dep("alpha", "*") }), candidates);
  assert.equal(stable.alpha?.manifest.version, "1.0.0");
  const preview = await resolveGraph(manifest("root", "1.0.0", { alpha: dep("alpha", "^2.0.0-beta.1") }), candidates);
  assert.equal(preview.alpha?.manifest.version, "2.0.0-beta.1");
});
