import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateTokenWithSecret,
  verifyTokenWithSecret,
} from "../src/services/auth.js";
import { AuthError } from "../src/services/errors.js";

const TEST_SECRET = "test-secret-key";

describe("Auth Service", () => {
  describe("generateTokenWithSecret", () => {
    it("should generate a valid JWT token", () => {
      const token = generateTokenWithSecret(
        "agent-123",
        "agent",
        TEST_SECRET
      );
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");

      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.sub).toBe("agent-123");
      expect(decoded.type).toBe("agent");
    });

    it("should generate tokens for users", () => {
      const token = generateTokenWithSecret(
        "user-456",
        "user",
        TEST_SECRET
      );
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.sub).toBe("user-456");
      expect(decoded.type).toBe("user");
    });

    it("should set expiry", () => {
      const token = generateTokenWithSecret(
        "agent-123",
        "agent",
        TEST_SECRET,
        "1h"
      );
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.exp).toBeDefined();
      expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });
  });

  describe("verifyTokenWithSecret", () => {
    it("should verify a valid token", () => {
      const token = generateTokenWithSecret(
        "agent-123",
        "agent",
        TEST_SECRET
      );
      const payload = verifyTokenWithSecret(token, TEST_SECRET);
      expect(payload.sub).toBe("agent-123");
      expect(payload.type).toBe("agent");
    });

    it("should reject an invalid token", () => {
      expect(() =>
        verifyTokenWithSecret("invalid-token", TEST_SECRET)
      ).toThrow(AuthError);
    });

    it("should reject a token signed with wrong secret", () => {
      const token = generateTokenWithSecret(
        "agent-123",
        "agent",
        "wrong-secret"
      );
      expect(() => verifyTokenWithSecret(token, TEST_SECRET)).toThrow(
        AuthError
      );
    });

    it("should reject an expired token", () => {
      const token = generateTokenWithSecret(
        "agent-123",
        "agent",
        TEST_SECRET,
        "0s"
      );
      // Token is immediately expired
      expect(() => verifyTokenWithSecret(token, TEST_SECRET)).toThrow(
        AuthError
      );
    });
  });
});
