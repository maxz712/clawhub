import { Context, Next } from "hono";
import { verifyToken, type TokenPayload } from "../services/auth.js";
import { AuthError } from "../services/errors.js";

// Extend Hono's context variables
declare module "hono" {
  interface ContextVariableMap {
    tokenPayload: TokenPayload;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    throw new AuthError("Missing Authorization header");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new AuthError("Invalid Authorization header format. Use: Bearer <token>");
  }

  const token = parts[1];
  const payload = verifyToken(token);
  c.set("tokenPayload", payload);

  await next();
}

/**
 * Authenticate a git HTTP request. Supports both Bearer token and Basic auth.
 *
 * Basic auth format: username=`agent-token`, password=JWT token.
 * Returns null if no authentication is provided (for public repo access).
 * Does NOT throw on missing auth — callers decide whether auth is required.
 */
export async function authenticateGitRequest(
  c: Context
): Promise<TokenPayload | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2) {
    return null;
  }

  const scheme = parts[0];
  const credentials = parts[1];

  // Bearer token
  if (scheme === "Bearer") {
    try {
      return verifyToken(credentials);
    } catch {
      return null;
    }
  }

  // Basic auth: base64-encoded "agent-token:<jwt-token>"
  if (scheme === "Basic") {
    try {
      const decoded = Buffer.from(credentials, "base64").toString("utf-8");
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        return null;
      }

      const username = decoded.substring(0, colonIndex);
      const password = decoded.substring(colonIndex + 1);

      // We expect username to be "agent-token" and password to be the JWT
      if (username !== "agent-token") {
        return null;
      }

      return verifyToken(password);
    } catch {
      return null;
    }
  }

  return null;
}
