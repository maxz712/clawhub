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
    },
  },
});
