import semver from "semver";
import type { Candidate, Manifest, Provider, Requirement } from "./model.js";
import { packageKey, satisfiesVersion, sourceKey } from "./manifest.js";

interface Constraint extends Requirement { from: string }

export class ResolutionError extends Error {}

export function assertAcyclic(root: Manifest, packages: Record<string, Candidate>): void {
  const visit = (name: string, ancestors: string[]): void => {
    if (ancestors.includes(name)) throw new ResolutionError(`Dependency cycle: ${[...ancestors, name].join(" -> ")}`);
    const manifest = name === root.name ? root : packages[name]?.manifest;
    if (!manifest) throw new Error(`Missing dependency: ${name}`);
    for (const dependency of Object.keys(manifest.dependencies)) visit(dependency, [...ancestors, name]);
  };
  visit(root.name, []);
}

export async function resolveGraph(root: Manifest, provider: Provider): Promise<Record<string, Candidate>> {
  const search = async (selected: Record<string, Candidate>): Promise<Record<string, Candidate>> => {
    const constraints = new Map<string, Constraint[]>();
    for (const manifest of [root, ...Object.values(selected).map(c => c.manifest)]) {
      for (const [name, requirement] of Object.entries(manifest.dependencies)) {
        if (name === root.name) throw new ResolutionError(`Dependency cycle reaches root '${root.name}' from '${manifest.name}'`);
        constraints.set(name, [...constraints.get(name) ?? [], { ...requirement, from: manifest.name }]);
      }
    }
    for (const [name, requirements] of constraints) {
      const description = requirements.map(r => `${r.from} requires ${name}@${r.range ?? "(revision-only)"} (${sourceKey(r.source)})`).join("; ");
      const first = requirements[0]!;
      if (requirements.some(r => sourceKey(r.source) !== sourceKey(first.source))) {
        throw new ResolutionError(`Source conflict: ${description}`);
      }
      if (requirements.some(r => packageKey(r.package) !== packageKey(first.package))) {
        throw new ResolutionError(`Packaging conflict for ${name}: ${requirements.map(r => r.from).join(", ")} declare different metadata or modes`);
      }
      const existing = selected[name];
      if (existing && !requirements.every(r => satisfiesVersion(existing.manifest.version, r.range))) {
        throw new ResolutionError(`Version conflict: ${description}; selected ${existing.manifest.version}`);
      }
    }
    const unresolved = [...constraints.keys()].sort().find(name => !selected[name]);
    if (!unresolved) {
      assertAcyclic(root, selected);
      return selected;
    }
    const requirements = constraints.get(unresolved)!;
    const first = requirements[0]!;
    const candidates = (await provider.candidates(first.source,
      first.package ? { name: unresolved, package: first.package } : undefined))
      .filter(c => c.manifest.name === unresolved &&
        requirements.every(r => satisfiesVersion(c.manifest.version, r.range)))
      .sort((a, b) => a.manifest.version === null ? (b.manifest.version === null ? 0 : 1) :
        b.manifest.version === null ? -1 : semver.rcompare(a.manifest.version, b.manifest.version));
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await search({ ...selected, [unresolved]: candidate });
      } catch (error) {
        if (!(error instanceof ResolutionError)) throw error;
        failures.push(`${unresolved}@${candidate.manifest.version ?? candidate.revision ?? "(local)"}: ${error.message}`);
      }
    }
    throw new ResolutionError(`Cannot resolve ${unresolved}: ${requirements.map(r => `${r.from} requires ${r.range ?? "(revision-only)"}`).join("; ")}\n${failures.join("\n") || "No matching candidates with the expected package name."}`);
  };
  return search({});
}
