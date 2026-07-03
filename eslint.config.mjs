import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import eslintNextPlugin from "@next/eslint-plugin-next";
import stylistic from "@stylistic/eslint-plugin";
import js from "@eslint/js";

const eslintConfig = defineConfig([
  js.configs.recommended,
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      next: eslintNextPlugin,
      "@stylistic": stylistic,
    },
    rules: {
      "@stylistic/semi": ["error", "always"],
      "@stylistic/brace-style": ["error", "allman", { allowSingleLine: true }], // Fixed typo
      "@stylistic/indent": ["error", "tab"],
      "@stylistic/no-trailing-spaces": "error",
      "prefer-const": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": "warn", // Use TS version
    },
  },
]);

export default eslintConfig;