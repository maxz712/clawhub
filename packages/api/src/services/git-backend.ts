import { spawn } from "node:child_process";

export const GIT_HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

/**
 * Spawns git-http-backend as a CGI child process and returns a proper Response.
 *
 * @param env - CGI environment variables for git-http-backend
 * @param body - Optional request body (for POST requests like git-upload-pack)
 * @returns A Response object with parsed CGI headers and body
 */
export function proxyToGitBackend(
  env: Record<string, string>,
  body?: ArrayBuffer
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const proc = spawn(GIT_HTTP_BACKEND, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn git-http-backend: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git-http-backend exited with code ${code}: ${stderrData}`
          )
        );
        return;
      }

      const output = Buffer.concat(chunks);

      // Parse CGI output: headers separated from body by \r\n\r\n
      const separator = Buffer.from("\r\n\r\n");
      const separatorIndex = output.indexOf(separator);

      if (separatorIndex === -1) {
        // No header/body separator found — treat entire output as body
        resolve(new Response(output, { status: 200 }));
        return;
      }

      const headerSection = output.subarray(0, separatorIndex).toString("utf-8");
      const bodySection = output.subarray(separatorIndex + separator.length);

      // Parse CGI headers
      const headers = new Headers();
      let status = 200;

      for (const line of headerSection.split("\r\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;

        const name = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();

        if (name.toLowerCase() === "status") {
          // CGI Status header: "200 OK" or "404 Not Found"
          const statusCode = parseInt(value, 10);
          if (!isNaN(statusCode)) {
            status = statusCode;
          }
        } else {
          headers.set(name, value);
        }
      }

      resolve(new Response(bodySection, { status, headers }));
    });

    // Write request body to stdin if provided
    if (body && body.byteLength > 0) {
      proc.stdin.write(Buffer.from(body));
    }
    proc.stdin.end();
  });
}
