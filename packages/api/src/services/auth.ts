import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

export type TokenPayload =
  | { kind: "user"; userId: string; email: string }
  | { kind: "agent"; agentId: string; name: string };

export function signToken(payload: TokenPayload, expiresIn: string = "365d"): string {
  return jwt.sign(payload, SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, SECRET) as TokenPayload;
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, 8);
}
export async function matchesHash(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
