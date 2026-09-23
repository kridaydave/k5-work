import { useCallback, useEffect, useRef, useState } from "react";
import {
  ProjectDiscoveryResponseSchema,
  ProjectSchema,
  type Project,
} from "@k5-work/shared";

const STORAGE_KEY_PROJECTS = "k5_local_projects";
const STORAGE_KEY_ACTIVE = "k5_active_project_id";

function readStoredProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return ProjectSchema.array().safeParse(parsed).data ?? [];
  } catch {
    return [];
  }
}

function writeStoredProjects(projects: Project[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  } catch {
    return;
  }
}

function readStoredProjectId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE) ?? "";
  } catch {
    return "";
  }
}

function writeStoredProjectId(id: string): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY_ACTIVE, id);
    else localStorage.removeItem(STORAGE_KEY_ACTIVE);
  } catch {
    return;
  }
}

function mergeProjects(discovered: Project[], stored: Project[]): Project[] {
  const projects = new Map<string, Project>();
  for (const project of stored) projects.set(project.path, project);
  for (const project of discovered) {
    projects.set(project.path, { ...projects.get(project.path), ...project });
  }
  return Array.from(projects.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
    return value.error;
  }
  return undefined;
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(readStoredProjectId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadVersion = useRef(0);

  useEffect(() => {
    const version = ++loadVersion.current;

    async function loadProjects() {
      const stored = readStoredProjects();
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("Project discovery is unavailable");
        const parsed = ProjectDiscoveryResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Project discovery returned invalid data");
        if (version !== loadVersion.current) return;
        const merged = mergeProjects(parsed.data.projects, stored);
        setProjects(merged);
        const savedId = readStoredProjectId();
        const initial =
          merged.find((project) => project.id === savedId) ??
          merged.find((project) => project.path === parsed.data.currentProjectPath) ??
          merged[0];
        setActiveProjectId(initial?.id ?? "");
        writeStoredProjectId(initial?.id ?? "");
        setError("");
      } catch (cause) {
        if (version !== loadVersion.current) return;
        setProjects(stored);
        const savedId = readStoredProjectId();
        const initial = stored.find((project) => project.id === savedId) ?? stored[0];
        setActiveProjectId(initial?.id ?? "");
        setError(cause instanceof Error ? cause.message : "Project discovery is unavailable");
      } finally {
        if (version === loadVersion.current) setLoading(false);
      }
    }

    void loadProjects();
    return () => {
      loadVersion.current += 1;
    };
  }, []);

  const selectProject = useCallback((id: string) => {
    setActiveProjectId(id);
    writeStoredProjectId(id);
  }, []);

  const openPath = useCallback(
    async (rawPath: string): Promise<Project> => {
      const response = await fetch("/api/projects/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rawPath.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(getErrorMessage(body) ?? "The folder could not be opened");
      }
      const parsed = ProjectSchema.safeParse(body);
      if (!parsed.success) throw new Error("The server returned invalid project data");
      loadVersion.current += 1;
      setLoading(false);
      setError("");
      const stored = [
        parsed.data,
        ...readStoredProjects().filter((project) => project.path !== parsed.data.path),
      ];
      writeStoredProjects(stored);
      setProjects((current) => [
        parsed.data,
        ...current.filter((project) => project.path !== parsed.data.path),
      ]);
      selectProject(parsed.data.id);
      return parsed.data;
    },
    [selectProject],
  );

  const activeProject = projects.find((project) => project.id === activeProjectId);

  return {
    projects,
    activeProject,
    loading,
    error,
    selectProject,
    openPath,
  };
}
