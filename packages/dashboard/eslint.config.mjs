import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Experimental React-Compiler-oriented rules bundled into recent
      // eslint-config-next. The dashboard predates them — every data-fetching
      // page sets state in its load effect — so keep them visible as WARNINGS
      // rather than blocking CI on a freshly-bundled rule, or mass-rewriting
      // dozens of working effects without per-page verification. Revisit as a
      // deliberate migration.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
