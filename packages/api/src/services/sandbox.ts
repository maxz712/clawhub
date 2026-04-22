import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { sandboxes, type Sandbox } from "../models/schema.js";

export interface SandboxLaunchInput {
  agentId: string;
  repoId: string;
  ref?: string;
  image?: string;
  command: string;
  timeoutMs?: number;
  memoryMb?: number;
  cpus?: number;
  networkMode?: "none" | "host" | "bridge";
}

/**
 * Docker-backed sandboxed exec. If the Docker CLI is not available, the row is
 * still created and marked `failed` with a clear error — this lets the API path
 * always succeed and the dashboard surface the real problem to the operator.
 */
export class SandboxService {
  constructor(private db: DB, public readonly docker: string = process.env.CLAWHUB_DOCKER ?? "docker") {}

  async launch(input: SandboxLaunchInput): Promise<Sandbox> {
    const [row] = await this.db.insert(sandboxes).values({
      agentId: input.agentId,
      repoId: input.repoId,
      ref: input.ref ?? null,
      image: input.image ?? "node:20-slim",
      command: input.command,
    }).returning();

    void this.runDetached(row.id, input).catch(async err => {
      await this.db.update(sandboxes).set({
        status: "failed",
        stderr: String(err?.message ?? err),
        finishedAt: new Date(),
      }).where(eq(sandboxes.id, row.id));
    });

    return row;
  }

  async kill(id: string): Promise<void> {
    const row = (await this.db.select().from(sandboxes).where(eq(sandboxes.id, id)).limit(1))[0];
    if (!row) return;
    if (row.containerId) {
      try { await this.exec(["kill", row.containerId]); } catch {}
    }
    await this.db.update(sandboxes).set({ status: "killed", finishedAt: new Date() }).where(eq(sandboxes.id, id));
  }

  async get(id: string): Promise<Sandbox | null> {
    return (await this.db.select().from(sandboxes).where(eq(sandboxes.id, id)).limit(1))[0] ?? null;
  }

  private async runDetached(id: string, input: SandboxLaunchInput): Promise<void> {
    await this.db.update(sandboxes).set({ status: "running", startedAt: new Date() }).where(eq(sandboxes.id, id));

    const timeoutMs = input.timeoutMs ?? 60_000;
    const memoryMb = input.memoryMb ?? 512;
    const cpus = input.cpus ?? 1;
    const net = input.networkMode ?? "none";

    const args = [
      "run", "--rm",
      "--memory", `${memoryMb}m`,
      "--cpus", String(cpus),
      "--network", net,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs", "/tmp:size=128m,mode=1777",
      input.image ?? "node:20-slim",
      "sh", "-c", input.command,
    ];

    try {
      const { stdout, stderr, exitCode } = await this.runDocker(args, timeoutMs);
      await this.db.update(sandboxes).set({
        status: exitCode === 0 ? "finished" : "failed",
        stdout, stderr, exitCode,
        finishedAt: new Date(),
      }).where(eq(sandboxes.id, id));
    } catch (e) {
      await this.db.update(sandboxes).set({
        status: "failed",
        stderr: String((e as Error).message ?? e),
        finishedAt: new Date(),
      }).where(eq(sandboxes.id, id));
    }
  }

  private runDocker(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      let killed = false;
      const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
      child.stdout.on("data", d => out += d.toString());
      child.stderr.on("data", d => err += d.toString());
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("close", code => {
        clearTimeout(timer);
        if (killed) return resolve({ stdout: out, stderr: err + "\n[clawhub] killed after timeout\n", exitCode: 137 });
        resolve({ stdout: out, stderr: err, exitCode: code ?? 0 });
      });
    });
  }

  private exec(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
  }
}
