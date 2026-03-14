import { Hono } from "hono";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { users } from "../models/schema.js";
import { generateToken } from "../services/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  ValidationError,
  NotFoundError,
  AuthError,
  ConflictError,
} from "../services/errors.js";
import {
  exchangeGitHubCode,
  exchangeGoogleCode,
} from "../services/oauth.js";
import type { Database } from "../models/db.js";

export function createUserRoutes(db: Database) {
  const app = new Hono();

  // POST /api/v1/users/register — Register a new user
  app.post("/register", async (c) => {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      throw new ValidationError("email and password are required");
    }

    if (typeof email !== "string" || !email.includes("@")) {
      throw new ValidationError("Invalid email format");
    }

    if (typeof password !== "string" || password.length < 8) {
      throw new ValidationError("Password must be at least 8 characters");
    }

    // Check if user already exists
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      throw new ConflictError("A user with this email already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        authProvider: "email",
      })
      .returning();

    const token = generateToken(user.id, "user");

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          created_at: user.createdAt,
        },
        token,
      },
      201
    );
  });

  // POST /api/v1/users/login — Login
  app.post("/login", async (c) => {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      throw new ValidationError("email and password are required");
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      throw new AuthError("Invalid email or password");
    }

    if (!user.passwordHash) {
      throw new AuthError("Invalid email or password");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new AuthError("Invalid email or password");
    }

    const token = generateToken(user.id, "user");

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        created_at: user.createdAt,
      },
      token,
    });
  });

  // POST /api/v1/users/oauth/github — GitHub OAuth login
  app.post("/oauth/github", async (c) => {
    const body = await c.req.json();
    const { code } = body;

    if (!code || typeof code !== "string") {
      throw new ValidationError("code is required");
    }

    let profile;
    try {
      profile = await exchangeGitHubCode(code);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `OAuth authentication failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }

    // Find or create user
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    let user;
    if (existing) {
      if (existing.authProvider !== "github_oauth") {
        [user] = await db
          .update(users)
          .set({ authProvider: "github_oauth" })
          .where(eq(users.id, existing.id))
          .returning();
      } else {
        user = existing;
      }
    } else {
      [user] = await db
        .insert(users)
        .values({
          email: profile.email,
          authProvider: "github_oauth",
        })
        .returning();
    }

    const token = generateToken(user.id, "user");

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        auth_provider: user.authProvider,
        created_at: user.createdAt,
      },
      token,
    });
  });

  // POST /api/v1/users/oauth/google — Google OAuth login
  app.post("/oauth/google", async (c) => {
    const body = await c.req.json();
    const { code, redirect_uri } = body;

    if (!code || typeof code !== "string") {
      throw new ValidationError("code is required");
    }

    if (!redirect_uri || typeof redirect_uri !== "string") {
      throw new ValidationError("redirect_uri is required");
    }

    let profile;
    try {
      profile = await exchangeGoogleCode(code, redirect_uri);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `OAuth authentication failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }

    // Find or create user
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    let user;
    if (existing) {
      if (existing.authProvider !== "google_oauth") {
        [user] = await db
          .update(users)
          .set({ authProvider: "google_oauth" })
          .where(eq(users.id, existing.id))
          .returning();
      } else {
        user = existing;
      }
    } else {
      [user] = await db
        .insert(users)
        .values({
          email: profile.email,
          authProvider: "google_oauth",
        })
        .returning();
    }

    const token = generateToken(user.id, "user");

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        auth_provider: user.authProvider,
        created_at: user.createdAt,
      },
      token,
    });
  });

  // GET /api/v1/users/me — Get current user info (protected)
  app.get("/me", authMiddleware, async (c) => {
    const payload = c.get("tokenPayload");

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) {
      throw new NotFoundError("User", payload.sub);
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        auth_provider: user.authProvider,
        created_at: user.createdAt,
      },
    });
  });

  return app;
}
