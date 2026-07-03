// ESLint flat config — real static analysis over src (typescript-eslint, non-type-checked).
// Intentionally lenient on stylistic/`any` rules (the code uses pragmatic `any` at FHIR/JSON
// boundaries); errors focus on genuine problems. Tighten over time.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.test.ts", "scripts/**", "*.config.js"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
);
