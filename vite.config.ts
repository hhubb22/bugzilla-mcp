import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    singleQuote: false,
    semi: true,
    printWidth: 100,
    ignorePatterns: ["specs/**", "dist/**", "node_modules/**"],
  },
  lint: {
    ignorePatterns: ["specs/**", "dist/**", "node_modules/**"],
  },
});
