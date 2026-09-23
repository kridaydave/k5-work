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
  try {
    const gitHeadPath = path.join(projectPath, ".git", "HEAD");
    if (!fs.existsSync(gitHeadPath)) return undefined;
    const content = fs.readFileSync(gitHeadPath, "utf8").trim();
    if (content.startsWith("ref: refs/heads/")) {
      return content.replace(/^ref: refs\/heads\//, "");
    }
    if (/^[0-9a-f]{7,40}$/i.test(content)) {
      return content.slice(0, 7);
    }
  } catch {
    // Ignore read errors
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
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;

    const name = path.basename(resolved) || "root";
    const branch = readGitBranch(resolved);
    const displayPath = formatHomeRelativePath(resolved);
    const meta = branch ? `${displayPath} · branch ${branch}` : displayPath;

    return ProjectSchema.parse({
      id: getProjectId(resolved, name),
      name,
      path: resolved,
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
  let cwd = currentRoot ? path.resolve(currentRoot) : process.cwd();

  // If cwd is inside apps/web or a sub-workspace, find the repository root
  if (fs.existsSync(path.join(cwd, "..", "package.json"))) {
    try {
      const parentPkg = JSON.parse(fs.readFileSync(path.join(cwd, "..", "package.json"), "utf8"));
      if (parentPkg.workspaces) {
        cwd = path.resolve(cwd, "..");
      }
    } catch {}
  }
  if (fs.existsSync(path.join(cwd, "../..", "package.json"))) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(cwd, "../..", "package.json"), "utf8"));
      if (rootPkg.workspaces) {
        cwd = path.resolve(cwd, "../..");
      }
    } catch {}
  }

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
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;

      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const subPath = path.join(root, entry.name);
        try {
          const real = fs.realpathSync(subPath);
          if (discoveredMap.has(real)) continue;

          // Check if it's a project (e.g. contains .git, package.json, or non-empty workspace directory)
          const isProject =
            fs.existsSync(path.join(real, ".git")) ||
            fs.existsSync(path.join(real, "package.json")) ||
            fs.existsSync(path.join(real, "Cargo.toml")) ||
            fs.existsSync(path.join(real, "pyproject.toml")) ||
            fs.existsSync(path.join(real, "go.mod")) ||
            (fs.existsSync(real) && fs.readdirSync(real).filter((f) => !f.startsWith(".")).length > 0);

          if (isProject) {
            const info = getProjectInfo(real);
            if (info) {
              discoveredMap.set(real, info);
            }
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip inaccessible root
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
