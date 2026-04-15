import { spawn } from "node:child_process";
import type { Context } from "hono";
import type { GitService } from "./git.js";

/**
 * Proxy an HTTP request to `git http-backend` CGI for a given repo.
 * Receives the repo path resolved upstream, plus the CGI-style suffix
 * (everything after `<repo>.git/`).
 */
export async function proxyToGitBackend(c: Context, git: GitService, namespace: string, repoName: string, pathSuffix: string): Promise<Response> {
  const repoPath = git.pathOf(namespace, repoName);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: repoPath,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${pathSuffix}`,
    REQUEST_METHOD: c.req.method,
    QUERY_STRING: new URL(c.req.url).search.replace(/^\?/, ""),
    CONTENT_TYPE: c.req.header("content-type") ?? "",
    CONTENT_LENGTH: c.req.header("content-length") ?? "",
    REMOTE_USER: "agent",
    REMOTE_ADDR: c.req.header("x-forwarded-for") ?? "",
  };

  const child = spawn("git", ["http-backend"], { env });

  // Stream request body into stdin.
  const body = c.req.raw.body;
  if (body) {
    const reader = body.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          child.stdin.write(value);
        }
      } catch {}
      child.stdin.end();
    })();
  } else {
    child.stdin.end();
  }

  // Parse CGI headers, then stream the body.
  const headerPromise = new Promise<{ status: number; headers: Headers; bodyStream: ReadableStream<Uint8Array> }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerFinished = false;
    let rawHeader = Buffer.alloc(0);

    const rs = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (chunk: Buffer) => {
          if (!headerFinished) {
            rawHeader = Buffer.concat([rawHeader, chunk]);
            const sep = rawHeader.indexOf(Buffer.from("\r\n\r\n"));
            if (sep === -1) return;
            const headerText = rawHeader.slice(0, sep).toString("utf8");
            const rest = rawHeader.slice(sep + 4);
            headerFinished = true;

            const headers = new Headers();
            let status = 200;
            for (const line of headerText.split(/\r?\n/)) {
              const idx = line.indexOf(":");
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim();
              const value = line.slice(idx + 1).trim();
              if (/^status$/i.test(name)) {
                const m = value.match(/^(\d+)/);
                if (m) status = Number(m[1]);
              } else headers.set(name, value);
            }
            resolve({ status, headers, bodyStream: rs });
            if (rest.length) controller.enqueue(new Uint8Array(rest));
          } else {
            controller.enqueue(new Uint8Array(chunk));
          }
        });
        child.stdout.on("end", () => controller.close());
        child.stdout.on("error", e => controller.error(e));
        child.on("error", e => reject(e));
      },
    });
  });

  const { status, headers, bodyStream } = await headerPromise;
  return new Response(bodyStream, { status, headers });
}
