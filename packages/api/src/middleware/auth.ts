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
