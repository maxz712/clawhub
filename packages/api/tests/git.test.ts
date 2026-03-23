import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitService } from "../src/services/git.js";

describe("GitService", () => {
  let gitService: GitService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawforge-test-"));
    gitService = new GitService({ basePath: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initBareRepo", () => {
    it("should create a bare git repository", async () => {
      const repoPath = await gitService.initBareRepo("test-repo.git");
      expect(repoPath).toContain("test-repo.git");

      // Verify it's a bare repo by listing files on main
      const files = await gitService.listFiles("test-repo.git", "main");
      expect(Array.isArray(files)).toBe(true);
    });

    it("should create nested repo paths", async () => {
      const repoPath = await gitService.initBareRepo(
        "user-123/my-project.git"
      );
      expect(repoPath).toContain("user-123/my-project.git");
    });
  });

  describe("createBranch", () => {
    it("should create a new branch from main", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch(
        "test-repo.git",
        "feature/test",
        "main"
      );

      // Verify branch exists by listing files on it
      const files = await gitService.listFiles(
        "test-repo.git",
        "feature/test"
      );
      expect(Array.isArray(files)).toBe(true);
    });
  });
});
