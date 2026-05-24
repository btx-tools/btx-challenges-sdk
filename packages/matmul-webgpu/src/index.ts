/**
 * `@btx-tools/matmul-webgpu` — WebGPU/WGSL solver kernel for BTX matmul service
 * challenges. Byte-exact clean-room port of `@btx-tools/challenges-sdk`'s
 * `core/src/matmul/*.ts`; consumed by the SDK's `Solver` `mode:'webgpu'` and by
 * browser miners. See README for honest perf + the low-n/verification-asymmetry note.
 */
export { createWebGpuSolver } from './solver.js';
export type { WebGpuSolver, WebGpuSolution, WebGpuSolverInit } from './solver.js';
export {
  buildParams,
  validateMatmulParams,
  assertTranscriptCapacity,
  M31_MODULUS,
  MAX_MATMUL_N,
  MAX_MATMUL_R,
  MAX_BLOCKS_PER_SIDE,
  DOMAIN_TAGS,
} from './header.js';
export type { SolveParams } from './header.js';
export { buildSolveShader } from './wgsl/shaders.js';
export { clampBatchSize, DEFAULT_BATCH, MAX_BATCH } from './limits.js';
export type { DeviceLimitsLike } from './limits.js';
export { createGpuKernel, GpuKernel, FILL_WORKGROUP_SIZE } from './kernel.js';
export type { BatchHit } from './kernel.js';
