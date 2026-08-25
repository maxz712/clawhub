import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      // Tests register throwaway agents headlessly; the hosted product gates
      // registration behind a human account (v2 agents-ux).
      CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER: "1",
      // A fixed valid 32-byte base64 sealing key, present BEFORE any module
      // loads (secrets.ts captures the key in a module-level const at import,
      // so a test setting it at top-level is already too late). Without it,
      // seal-on-create routes 400 "server missing CLAWHUB_SECRETS_KEY" as their
      // first check and downstream gate assertions pass vacuously (#215 test).
      // Test-only throwaway key — never a production secret.
      CLAWHUB_SECRETS_KEY: "t7rXwwt9mW97YP5AlAuouk/UM7WCHJ55DtAw+hWOutM=",
    },
  },
});
