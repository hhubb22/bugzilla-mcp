import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    singleQuote: false,
    semi: true,
    printWidth: 100,
    ignorePatterns: ["specs/**", "dist/**", "dist-web/**", "docker/**", "node_modules/**"],
  },
  lint: {
    ignorePatterns: ["specs/**", "dist/**", "dist-web/**", "docker/**", "node_modules/**"],
  },
});
