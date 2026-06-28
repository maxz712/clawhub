import { createHmac, createHash } from "node:crypto";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export interface ObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<{ etag: string; size: number }>;
  get(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number; contentType?: string } | null>;
  exists(key: string): Promise<boolean>;
  url(key: string, ttlSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export class LocalObjectStore implements ObjectStore {
  constructor(public readonly baseDir: string, public readonly publicBase: string = "") {}

  private pathFor(key: string): string {
    // Reject `..` and absolute keys; then assert the resolved path stays inside
    // baseDir — an absolute or crafted key must never escape the store root.
    if (key.includes("..") || path.isAbsolute(key)) throw new Error("illegal_key");
    const base = path.resolve(this.baseDir);
    const resolved = path.resolve(base, key);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("illegal_key");
    return resolved;
  }

  async put(key: string, body: Buffer): Promise<{ etag: string; size: number }> {
    const dest = this.pathFor(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${Date.now()}`;
    const fh = await open(tmp, "w");
    try { await fh.write(body); } finally { await fh.close(); }
    await rename(tmp, dest);
    return { etag: createHash("sha256").update(body).digest("hex"), size: body.length };
  }

  async get(key: string) {
    const p = this.pathFor(key);
    try { const s = await stat(p); return { stream: createReadStream(p), size: s.size }; }
    catch { return null; }
  }

  async exists(key: string): Promise<boolean> {
    try { await stat(this.pathFor(key)); return true; } catch { return false; }
  }

  async url(key: string): Promise<string> {
    return this.publicBase ? `${this.publicBase.replace(/\/+$/, "")}/${key}` : `file://${this.pathFor(key)}`;
  }

  async delete(key: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    try { await rm(this.pathFor(key)); } catch {}
  }
}

// S3 — SigV4 presign + direct PUT/GET. No SDK dep.
export interface S3Config { region: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string; publicBase?: string }

export class S3ObjectStore implements ObjectStore {
  constructor(private cfg: S3Config) {}

  private host(): string {
    if (this.cfg.endpoint) return this.cfg.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<{ etag: string; size: number }> {
    const host = this.host();
    const url = `https://${host}/${encodeURI(key)}`;
    const headers = this.sign("PUT", `/${encodeURI(key)}`, body, contentType);
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw new Error(`s3_put_${res.status}:${await res.text()}`);
    const etag = res.headers.get("etag")?.replace(/"/g, "") ?? createHash("sha256").update(body).digest("hex");
    return { etag, size: body.length };
  }

  async get(key: string) {
    const url = `https://${this.host()}/${encodeURI(key)}`;
    const headers = this.sign("GET", `/${encodeURI(key)}`, Buffer.alloc(0));
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3_get_${res.status}`);
    const size = Number(res.headers.get("content-length") ?? 0);
    const contentType = res.headers.get("content-type") ?? undefined;
    if (!res.body) return null;
    // Convert web-stream → node-readable for callers that pipe.
    const { Readable } = await import("node:stream");
    // Node 20 supports Readable.fromWeb.
    const stream = (Readable as unknown as { fromWeb: (s: ReadableStream<Uint8Array>) => NodeJS.ReadableStream }).fromWeb(res.body);
    return { stream, size, contentType };
  }

  async exists(key: string): Promise<boolean> {
    const headers = this.sign("HEAD", `/${encodeURI(key)}`, Buffer.alloc(0));
    const res = await fetch(`https://${this.host()}/${encodeURI(key)}`, { method: "HEAD", headers });
    return res.ok;
  }

  async url(key: string, ttlSeconds = 3600): Promise<string> {
    // Presigned GET URL.
    return presignS3Get(this.cfg, key, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    const headers = this.sign("DELETE", `/${encodeURI(key)}`, Buffer.alloc(0));
    const res = await fetch(`https://${this.host()}/${encodeURI(key)}`, { method: "DELETE", headers });
    if (!res.ok && res.status !== 204) throw new Error(`s3_delete_${res.status}`);
  }

  private sign(method: string, canonicalUri: string, body: Buffer, contentType?: string): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const host = this.host();
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;

    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map(k => `${k}:${headers[k]}\n`).join("");
    const signedHeaders = signed.join(";");
    const canonical = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");

    const kDate = createHmac("sha256", "AWS4" + this.cfg.secretAccessKey).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(this.cfg.region).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }
}

function presignS3Get(cfg: S3Config, key: string, ttl: number): string {
  const host = cfg.endpoint ? cfg.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const credential = `${cfg.accessKeyId}/${scope}`;
  const signedHeaders = "host";
  const q = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": signedHeaders,
  });
  const canonicalUri = `/${encodeURI(key)}`;
  const canonical = ["GET", canonicalUri, q.toString(), `host:${host}\n`, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const kDate = createHmac("sha256", "AWS4" + cfg.secretAccessKey).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(cfg.region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  q.set("X-Amz-Signature", signature);
  return `https://${host}${canonicalUri}?${q.toString()}`;
}

export function buildObjectStoreFromEnv(localBase: string): ObjectStore {
  const kind = (process.env.CLAWHUB_OBJECT_STORE ?? "local").toLowerCase();
  if (kind === "s3" && process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID) {
    return new S3ObjectStore({
      region: process.env.AWS_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      endpoint: process.env.S3_ENDPOINT,
      publicBase: process.env.S3_PUBLIC_BASE,
    });
  }
  return new LocalObjectStore(localBase);
}
