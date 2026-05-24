import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Headless unit tests (mock adapter + pure-js backend) run in CI under vitest.
    // The real-GPU end-to-end gate lives in tests/gpu/ and runs under Deno
    // (`deno run --unstable-webgpu`); see README → Testing.
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
