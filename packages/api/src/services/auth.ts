import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

export type TokenPayload =
  // `v` is the session version checked against users.token_version; tokens
  // minted before the claim existed are treated as v=0.
  | { kind: "user"; userId: string; email: string; v?: number }
  | { kind: "agent"; agentId: string; name: string };

export function signToken(payload: TokenPayload, expiresIn: string = "365d"): string {
  return jwt.sign(payload, SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  // Pin the algorithm: we sign HS256, so accepting any algorithm would let a
  // forged header (e.g. "alg":"none") bypass verification. Signing is unchanged.
  return jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as TokenPayload;
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

// Token hashing is sha256, NOT bcrypt: bcrypt truncates input at 72 bytes,
// and a JWT's first 72 bytes are the static header plus a few payload chars —
// two different tokens for the same principal would compare equal. Tokens
// already carry full entropy, so a fast deterministic hash is correct here.
export async function hashToken(token: string): Promise<string> {
  return createHash("sha256").update(token).digest("hex");
}
export async function matchesHash(token: string, hash: string): Promise<boolean> {
  // Hashes written before the sha256 switch are bcrypt ("$2…"); accept them
  // so existing agent tokens survive the upgrade. They rotate out naturally —
  // any rotate-token call rewrites the row as sha256.
  if (hash.startsWith("$2")) return bcrypt.compare(token, hash);
  const a = Buffer.from(createHash("sha256").update(token).digest("hex"));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
