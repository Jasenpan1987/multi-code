import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // `release/` is electron-builder's output (packaged apps and compiled
    // bundles), not source. Same reason dist/ is here.
    ignores: ["dist/", "release/", "node_modules/", "*.config.*"],
  }
);
