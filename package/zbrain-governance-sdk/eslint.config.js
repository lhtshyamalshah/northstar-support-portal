import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage", "dist", "node_modules", "tsconfig.tsbuildinfo", "docs"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.config.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports"
        }
      ]
    }
  }
);
