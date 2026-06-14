import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "apps/",
      "node_modules/",
      "cqui/",
      "ghj/",
      "pied/",
      "sport-screen/",
      "sport/",
      "teste/",
      "electron/projects/",
      // Browser-context view scripts externalized from inline <script> (CSP: script-src 'self').
      // Plain JS run in the renderer, same category as electron/projects/*.js.
      "electron/nav-popup.js",
      "electron/sidebar-ui.js",
      "electron/chat.js",
      "**/*.test.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["electron/**/*.ts", "scripts/**/*.ts"],
    ignores: ["electron/preload.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/strict-boolean-expressions": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["electron/preload.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: "./electron/tsconfig.preload.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/strict-boolean-expressions": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
    },
  },
);
