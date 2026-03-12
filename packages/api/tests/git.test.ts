import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitService } from "../src/services/git.js";
import { GitError } from "../src/services/errors.js";

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

  describe("applyDiff", () => {
    it("should apply file changes to a branch", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "test-branch");

      const commitHash = await gitService.applyDiff(
        "test-repo.git",
        "test-branch",
        [
          {
            path: "hello.txt",
            action: "create",
            content: "Hello, World!",
          },
        ],
        "Add hello.txt"
      );

      expect(commitHash).toBeDefined();
      expect(commitHash.length).toBeGreaterThan(0);

      // Verify file exists
      const files = await gitService.listFiles(
        "test-repo.git",
        "test-branch"
      );
      expect(files).toContain("hello.txt");
    });

    it("should create files in subdirectories", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "test-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "test-branch",
        [
          {
            path: "src/index.ts",
            action: "create",
            content: 'console.log("hello");',
          },
        ],
        "Add src/index.ts"
      );

      const files = await gitService.listFiles(
        "test-repo.git",
        "test-branch"
      );
      expect(files).toContain("src/index.ts");
    });

    it("should handle multiple file changes", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "test-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "test-branch",
        [
          { path: "a.txt", action: "create", content: "A" },
          { path: "b.txt", action: "create", content: "B" },
          { path: "c/d.txt", action: "create", content: "D" },
        ],
        "Add multiple files"
      );

      const files = await gitService.listFiles(
        "test-repo.git",
        "test-branch"
      );
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");
      expect(files).toContain("c/d.txt");
    });
  });

  describe("getFileContents", () => {
    it("should retrieve file contents from a branch", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "test-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "test-branch",
        [
          {
            path: "hello.txt",
            action: "create",
            content: "Hello, World!",
          },
        ],
        "Add hello.txt"
      );

      const content = await gitService.getFileContents(
        "test-repo.git",
        "hello.txt",
        "test-branch"
      );
      expect(content).toBe("Hello, World!");
    });
  });

  describe("getDiff", () => {
    it("should return diff between branches", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "feature-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "feature-branch",
        [
          {
            path: "new-file.txt",
            action: "create",
            content: "new content",
          },
        ],
        "Add new file"
      );

      const diff = await gitService.getDiff(
        "test-repo.git",
        "main",
        "feature-branch"
      );
      expect(diff).toContain("new-file.txt");
      expect(diff).toContain("new content");
    });
  });

  describe("mergeBranch", () => {
    it("should merge a branch into main", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "feature-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "feature-branch",
        [
          {
            path: "merged-file.txt",
            action: "create",
            content: "merged content",
          },
        ],
        "Add file for merge"
      );

      const commitHash = await gitService.mergeBranch(
        "test-repo.git",
        "feature-branch",
        "main"
      );
      expect(commitHash).toBeDefined();

      // Verify file is now on main
      const files = await gitService.listFiles("test-repo.git", "main");
      expect(files).toContain("merged-file.txt");
    });
  });

  describe("rollbackMerge", () => {
    it("should revert the last commit on a branch", async () => {
      await gitService.initBareRepo("test-repo.git");
      await gitService.createBranch("test-repo.git", "feature-branch");

      await gitService.applyDiff(
        "test-repo.git",
        "feature-branch",
        [
          {
            path: "to-revert.txt",
            action: "create",
            content: "will be reverted",
          },
        ],
        "Add file to revert"
      );

      await gitService.mergeBranch(
        "test-repo.git",
        "feature-branch",
        "main"
      );

      // Now rollback
      const revertHash = await gitService.rollbackMerge(
        "test-repo.git",
        "main"
      );
      expect(revertHash).toBeDefined();

      // File should be gone
      const files = await gitService.listFiles("test-repo.git", "main");
      expect(files).not.toContain("to-revert.txt");
    });
  });
});
