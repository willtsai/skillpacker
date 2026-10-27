import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { contained, filesUnder, integrity } from "./files.js";
import { nameSchema } from "./manifest.js";
import type { Manifest } from "./model.js";

export interface Inventory {
  files: string[];
  skills: { name: string; path: string; files: string[] }[];
  notices: string[];
  integrity: string;
}

export async function inventory(directory: string, manifest: Manifest): Promise<Inventory> {
  const skills: Inventory["skills"] = [];
  for (const skillPath of manifest.skills) {
    const file = await contained(directory, skillPath === "." ? "SKILL.md" : `${skillPath}/SKILL.md`);
    const text = await readFile(file, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter) throw new Error(`Missing skill frontmatter: ${file}`);
    const metadata = z.object({ name: nameSchema, description: z.string().min(1).max(1024) })
      .parse(parse(frontmatter[1]!));
    if (skillPath !== "." && metadata.name !== path.posix.basename(skillPath)) throw new Error(`Skill name must match directory: ${file}`);
    const files: string[] = [];
    if (skillPath === ".") {
      for (const entry of (await readdir(directory)).sort()) {
        if ([".git", "skillpacker.json", "skillpacker.lock.json"].includes(entry)) continue;
        files.push(...await filesUnder(directory, entry));
      }
    } else {
      files.push(...await filesUnder(directory, skillPath));
    }
    if (files.some(f => (skillPath === "." ? f : f.slice(skillPath.length + 1)).split("/").includes(".skillpacker"))) {
      throw new Error(`Reserved .skillpacker directory in ${skillPath}`);
    }
    skills.push({ name: metadata.name, path: skillPath, files });
  }
  const notices = new Set(manifest.notices);
  for (const entry of await readdir(directory)) {
    if (/^(LICENSE|LICENCE|COPYING|NOTICE|THIRD-PARTY-NOTICES)(\..*)?$/i.test(entry) ||
        entry === "LICENSES") {
      notices.add(entry);
    }
  }
  const noticeFiles: string[] = [];
  for (const notice of [...notices].sort()) noticeFiles.push(...await filesUnder(directory, notice));
  const files = [...new Set([...skills.flatMap(s => s.files), ...noticeFiles])].sort();
  for (const f of files) {
    if (!(await lstat(await contained(directory, f))).isFile()) throw new Error(`Not a regular file: ${f}`);
  }
  return { files, skills, notices: [...new Set(noticeFiles)].sort(), integrity: await integrity(directory, manifest, files) };
}
