// This is the resolver boundary, not the on-disk manifest format.
export type Source =
  | { type: "local"; path: string }
  | { type: "git"; url: string; subdir: string; ref?: string };

export interface Requirement {
  source: Source;
  range?: string;
  package?: PackageDefinition;
}

export interface PackageDefinition {
  skills: string[];
  notices: string[];
  dependencies: Record<string, Requirement>;
}

export interface PackageSelection {
  name: string;
  package: PackageDefinition;
}

export interface Manifest {
  name: string;
  version: string | null;
  skills: string[];
  dependencies: Record<string, Requirement>;
  notices: string[];
}

export interface ManifestReader {
  read(directory: string): Promise<Manifest>;
}

export interface Candidate {
  source: Source;
  revision?: string;
  tag?: string;
  package?: PackageDefinition;
  manifest: Manifest;
  directory: string;
}

export interface Provider {
  candidates(source: Source, selection?: PackageSelection): Promise<Candidate[]>;
}

export interface LockedPackage {
  source: Source;
  revision?: string;
  tag?: string;
  package?: PackageDefinition;
  manifest: Manifest;
  integrity: string;
}

export interface Lockfile {
  lockVersion: 1;
  root: { manifest: Manifest; integrity: string };
  packages: Record<string, LockedPackage>;
}

export type Target = "portable" | "copilot" | "claude";
