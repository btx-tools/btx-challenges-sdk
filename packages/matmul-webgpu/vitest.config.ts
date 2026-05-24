import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the pure orchestration tests run under vitest/Node (no WebGPU there).
    // The GPU byte-exact battery lives in tests/gpu/ and runs under Deno
    // (`deno run --unstable-webgpu`); see README → Testing.
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
