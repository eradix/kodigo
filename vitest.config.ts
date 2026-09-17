import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the unit suites. Vitest's default glob would also match the
    // end-to-end specs under e2e/, which are WebdriverIO's to run: they expect
    // a live app and a browser session, and merely importing one outside that
    // context throws.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
