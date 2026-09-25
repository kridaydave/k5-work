import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  type Project,
  type ProjectDiscoveryResponse,
  ProjectDiscoveryResponseSchema,
  ProjectSchema,
} from "@k5-work/shared";

export const MAX_GIT_HEAD_BYTES = 4096;
export const MAX_DISCOVERY_ENTRIES_PER_ROOT = 2000;
export const MAX_DISCOVERY_PROJECT_ENTRIES = 100;
export const MAX_DISCOVERY_PROJECTS = 500;

function canonicalDirectory(targetPath: string): string | null {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function hasVisibleEntry(directoryPath: string): boolean {
  let directory: fs.Dir | undefined;
  try {
    directory = fs.opendirSync(directoryPath);
    for (let index = 0; index < MAX_DISCOVERY_PROJECT_ENTRIES; index += 1) {
      const entry = directory.readSync();
      if (entry === null) return false;
      if (!entry.name.startsWith(".")) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    directory?.closeSync();
  }
}

function formatHomeRelativePath(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

function getProjectId(projectPath: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "project";
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function readGitBranch(projectPath: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const gitPath = path.join(projectPath, ".git");
    const gitStat = fs.lstatSync(gitPath);
    if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) return undefined;
    const realGitPath = fs.realpathSync(gitPath);
    const relativeGitPath = path.relative(projectPath, realGitPath);
    if (
      relativeGitPath === ".." ||
      relativeGitPath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeGitPath)
    ) {
      return undefined;
    }
    const gitHeadPath = path.join(realGitPath, "HEAD");
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(gitHeadPath, fs.constants.O_RDONLY | noFollow);
    const headStat = fs.fstatSync(descriptor);
    if (!headStat.isFile() || headStat.size > MAX_GIT_HEAD_BYTES) return undefined;
    const content = fs.readFileSync(descriptor, "utf8").trim();
    if (content.startsWith("ref: refs/heads/")) {
      return content.replace(/^ref: refs\/heads\//, "");
    }
    if (/^[0-9a-f]{7,40}$/i.test(content)) {
      return content.slice(0, 7);
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return undefined;
}

export function getProjectInfo(targetPath: string): Project | null {
  try {
    const expandedPath =
      targetPath === "~"
        ? os.homedir()
        : targetPath.startsWith("~/")
          ? path.join(os.homedir(), targetPath.slice(2))
          : targetPath;
    const resolved = path.resolve(expandedPath);
    const canonical = canonicalDirectory(resolved);
    if (canonical === null) return null;

    const name = path.basename(canonical) || "root";
    const branch = readGitBranch(canonical);
    const displayPath = formatHomeRelativePath(canonical);
    const meta = branch ? `${displayPath} · branch ${branch}` : displayPath;

    return ProjectSchema.parse({
      id: getProjectId(canonical, name),
      name,
      path: canonical,
      meta,
      branch,
      lastOpened: Date.now(),
    });
  } catch {
    return null;
  }
}

export function discoverLocalProjects(
  candidateRoots?: string[],
  currentRoot?: string,
): ProjectDiscoveryResponse {
  const discoveredMap = new Map<string, Project>();
  const cwd = currentRoot ? path.resolve(currentRoot) : process.cwd();

  // Root folders to search for projects
  const searchRoots: string[] = candidateRoots ?? [
    path.resolve(cwd, ".."), // Parent directory (e.g. /home/k5/code)
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "dev"),
    path.join(os.homedir(), "Work"),
  ];

  // Always include current directory
  const currentProj = getProjectInfo(cwd);
  if (currentProj) {
    discoveredMap.set(currentProj.path, currentProj);
  }

  for (const root of searchRoots) {
    if (discoveredMap.size >= MAX_DISCOVERY_PROJECTS) break;
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;

      const directory = fs.opendirSync(root);
      let examined = 0;
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          if (
            examined >= MAX_DISCOVERY_ENTRIES_PER_ROOT ||
            discoveredMap.size >= MAX_DISCOVERY_PROJECTS
          ) {
            break;
          }
          examined += 1;
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

          const subPath = path.join(root, entry.name);
          try {
            const real = fs.realpathSync(subPath);
            if (discoveredMap.has(real)) continue;

            const isProject =
              fs.existsSync(path.join(real, ".git")) ||
              fs.existsSync(path.join(real, "package.json")) ||
              fs.existsSync(path.join(real, "Cargo.toml")) ||
              fs.existsSync(path.join(real, "pyproject.toml")) ||
              fs.existsSync(path.join(real, "go.mod")) ||
              hasVisibleEntry(real);

            if (isProject) {
              const info = getProjectInfo(real);
              if (info) discoveredMap.set(real, info);
            }
          } catch {
            continue;
          }
        }
      } finally {
        directory.closeSync();
      }
    } catch {
      continue;
    }
  }

  const projects = Array.from(discoveredMap.values());
  // Sort: current project first, then alphabetical
  projects.sort((a, b) => {
    if (a.path === cwd) return -1;
    if (b.path === cwd) return 1;
    return a.name.localeCompare(b.name);
  });

  return ProjectDiscoveryResponseSchema.parse({
    projects,
    currentProjectPath: cwd,
  });
}
