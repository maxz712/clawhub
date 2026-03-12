import jwt from "jsonwebtoken";
import { AuthError } from "./errors.js";

export interface TokenPayload {
  sub: string; // agent or user ID
  type: "agent" | "user";
  iat?: number;
  exp?: number;
}

const getSecret = (): string => {
  return process.env.JWT_SECRET ?? "dev-secret-change-me";
};

export function generateToken(
  id: string,
  type: "agent" | "user",
  expiresIn: string = "30d"
): string {
  const payload: TokenPayload = {
    sub: id,
    type,
  };
  return jwt.sign(payload, getSecret(), { expiresIn });
}

export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, getSecret()) as TokenPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthError("Token expired");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthError("Invalid token");
    }
    throw new AuthError("Token verification failed");
  }
}

export function generateTokenWithSecret(
  id: string,
  type: "agent" | "user",
  secret: string,
  expiresIn: string = "30d"
): string {
  const payload: TokenPayload = {
    sub: id,
    type,
  };
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyTokenWithSecret(
  token: string,
  secret: string
): TokenPayload {
  try {
    const decoded = jwt.verify(token, secret) as TokenPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthError("Token expired");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthError("Invalid token");
    }
    throw new AuthError("Token verification failed");
  }
}
