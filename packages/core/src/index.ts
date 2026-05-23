/**
 * @btx-tools/challenges-sdk
 *
 * TypeScript SDK for BTX service challenges — chain-anchored proof-of-work
 * admission control for APIs, agent gateways, and form submissions.
 *
 * Built against btxd v0.29.7+. RPC reference: https://btx.dev/docs/rpc/service-challenges
 */

export { BtxChallengeClient } from './client.js';
export { Solver, type SolverOptions, type SolverMode } from './solver.js';
export type { SolveJsOptions } from './matmul/pow.js';
export {
  BtxError,
  BtxHttpError,
  BtxNetworkError,
  BtxParseError,
  BtxRpcError,
  BtxTimeoutError,
  type BatchEntry,
  type BatchResult,
  type BtxClientOpts,
  type Challenge,
  type ChallengeBinding,
  type ChallengeHeaderContext,
  type ChallengeMatmul,
  type ChallengePayload,
  type ChallengeProofPolicy,
  type ChallengePurpose,
  type DifficultyPolicy,
  type IssueParams,
  type RetryOptions,
  type RpcCallOpts,
  type SolverOutput,
  type VerifyReason,
  type VerifyResult,
} from './types.js';
