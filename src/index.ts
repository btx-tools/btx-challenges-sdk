/**
 * @btx/challenges-sdk
 *
 * TypeScript SDK for BTX service challenges — chain-anchored proof-of-work
 * admission control for APIs, agent gateways, and form submissions.
 *
 * Built against btxd v0.29.7+. RPC reference: https://btx.dev/docs/rpc/service-challenges
 */

export { BtxChallengeClient } from './client.js';
export {
  BtxHttpError,
  BtxRpcError,
  type BatchEntry,
  type BatchResult,
  type BtxClientOpts,
  type Challenge,
  type ChallengePurpose,
  type DifficultyPolicy,
  type IssueParams,
  type SolverOutput,
  type VerifyResult,
} from './types.js';
