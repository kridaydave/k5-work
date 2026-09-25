import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_GIT_HEAD_BYTES,
  discoverLocalProjects,
  getProjectInfo,
} from "./projects.js";

describe("local project discovery", () => {
  it("inspects existing project directory", () => {
    const cwd = process.cwd();
    const info = getProjectInfo(cwd);
    assert.ok(info);
    assert.equal(typeof info.name, "string");
    assert.equal(info.path, cwd);
  });

  it("expands a home-relative project path", () => {
    const info = getProjectInfo("~");
    assert.ok(info);
    assert.equal(info.path, os.homedir());
  });

  it("returns null for non-existent path or non-directory", () => {
    assert.equal(getProjectInfo("/non/existent/path/here"), null);
    const tempFile = path.join(os.tmpdir(), `k5-test-file-${Date.now()}`);
    fs.writeFileSync(tempFile, "hello");
    try {
      assert.equal(getProjectInfo(tempFile), null);
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  it("assigns unique ids to projects with the same name", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-id-test-"));
    try {
      const first = path.join(tempRoot, "first", "sample");
      const second = path.join(tempRoot, "second", "sample");
      fs.mkdirSync(first, { recursive: true });
      fs.mkdirSync(second, { recursive: true });
      const firstInfo = getProjectInfo(first);
      const secondInfo = getProjectInfo(second);
      assert.ok(firstInfo);
      assert.ok(secondInfo);
      assert.notEqual(firstInfo.id, secondInfo.id);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("discovers candidate projects within given roots", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-discover-test-"));
    try {
      // Create project A with git
      const projA = path.join(tempRoot, "proj-a");
      fs.mkdirSync(path.join(projA, ".git"), { recursive: true });
      fs.writeFileSync(path.join(projA, ".git", "HEAD"), "ref: refs/heads/feature-1\n");

      // Create project B with package.json
      const projB = path.join(tempRoot, "proj-b");
      fs.mkdirSync(projB, { recursive: true });
      fs.writeFileSync(path.join(projB, "package.json"), '{"name":"proj-b"}');

      // Create non-project empty dir
      const nonProj = path.join(tempRoot, "not-a-proj");
      fs.mkdirSync(nonProj, { recursive: true });

      const res = discoverLocalProjects([tempRoot]);
      assert.ok(res.projects.length >= 2);
      const names = res.projects.map((p) => p.name);
      assert.ok(names.includes("proj-a"));
      assert.ok(names.includes("proj-b"));
      assert.ok(!names.includes("not-a-proj"));

      const a = res.projects.find((p) => p.name === "proj-a");
      assert.equal(a?.branch, "feature-1");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked project roots", (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-link-test-"));
    try {
      const target = path.join(tempRoot, "target");
      const link = path.join(tempRoot, "link");
      fs.mkdirSync(target);
      try {
        fs.symlinkSync(target, link, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("symlink creation is not permitted");
          return;
        }
        throw error;
      }
      assert.equal(getProjectInfo(link), null);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows a symlinked ancestor while rejecting a symlinked project root", (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-ancestor-test-"));
    try {
      const realParent = path.join(tempRoot, "real-parent");
      const project = path.join(realParent, "project");
      const linkedParent = path.join(tempRoot, "linked-parent");
      fs.mkdirSync(project, { recursive: true });
      try {
        fs.symlinkSync(realParent, linkedParent, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("symlink creation is not permitted");
          return;
        }
        throw error;
      }
      const info = getProjectInfo(path.join(linkedParent, "project"));
      assert.equal(info?.path, fs.realpathSync(project));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not read symlinked or oversized Git HEAD files", (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-head-test-"));
    try {
      const linkedProject = path.join(tempRoot, "linked-project");
      const linkedGit = path.join(linkedProject, ".git");
      fs.mkdirSync(linkedGit, { recursive: true });
      const outsideHead = path.join(tempRoot, "outside-head");
      fs.writeFileSync(outsideHead, "ref: refs/heads/private-secret\n");
      try {
        fs.symlinkSync(outsideHead, path.join(linkedGit, "HEAD"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("symlink creation is not permitted");
          return;
        }
        throw error;
      }
      assert.equal(getProjectInfo(linkedProject)?.branch, undefined);

      const largeProject = path.join(tempRoot, "large-project");
      const largeGit = path.join(largeProject, ".git");
      fs.mkdirSync(largeGit, { recursive: true });
      fs.writeFileSync(
        path.join(largeGit, "HEAD"),
        `ref: refs/heads/${"x".repeat(MAX_GIT_HEAD_BYTES)}`,
      );
      assert.equal(getProjectInfo(largeProject)?.branch, undefined);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the supplied workspace root without climbing to a parent package", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-root-test-"));
    try {
      const child = path.join(tempRoot, "child");
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(tempRoot, "package.json"), '{"workspaces":["*"]}');
      const result = discoverLocalProjects([path.join(tempRoot, "missing")], child);
      assert.equal(result.currentProjectPath, child);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
