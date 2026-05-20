/**
 * @btx/challenges-sdk
 *
 * TypeScript SDK for BTX service challenges — chain-anchored proof-of-work
 * admission control for APIs, agent gateways, and form submissions.
 *
 * Built against btxd v0.29.7+. RPC reference: https://btx.dev/docs/rpc/service-challenges
 */

export { BtxChallengeClient } from './client.js';
export { Solver } from './solver.js';
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
  type SolverOutput,
  type VerifyReason,
  type VerifyResult,
} from './types.js';
