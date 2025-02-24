import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    pool: "src/index.ts",
    reporters: [["default", {"summary": false}]]
  }
});
