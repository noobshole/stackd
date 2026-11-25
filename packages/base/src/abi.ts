/**
 * The slices of the B20, Policy Registry and Chainlink interfaces that payouts
 * use. Browser-safe.
 *
 * Signatures follow the canonical Solidity in github.com/base/base-std
 * (src/interfaces/IB20.sol, IB20Asset.sol, IERC8056.sol, IPolicyRegistry.sol).
 * Tokenized stocks are B20 Asset precompiles: there is no bytecode at the token
 * address, so these ABIs are the only description of what can be called.
 */

import { parseAbi, type Address, type Hex } from 'viem';

export const b20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  // ERC-8056 scaled UI amount: one token is redeemable for multiplier / WAD shares.
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function balanceOfUI(address account) view returns (uint256)',
  'function toUIAmount(uint256 rawAmount) view returns (uint256)',
  // PausableFeature is a Solidity enum, which the ABI carries as uint8.
  'function isPaused(uint8 feature) view returns (bool)',
  'function policyId(bytes32 policyScope) view returns (uint64)',
  'function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event Memo(address indexed caller, bytes32 indexed memo)',
  'error ContractPaused(uint8 feature)',
  'error PolicyForbids(bytes32 policyScope, uint64 policyId)',
  'error InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error InvalidReceiver(address receiver)',
]);

export const policyRegistryAbi = parseAbi([
  // Never reverts: an unknown policy simply answers false (or true for ALWAYS_ALLOW).
  'function isAuthorized(uint64 policyId, address account) view returns (bool)',
]);

export const chainlinkFeedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Singleton precompiles (base-std StdPrecompiles.sol). */
export const POLICY_REGISTRY_ADDRESS: Address = '0x8453000000000000000000000000000000000002';
export const ACTIVATION_REGISTRY_ADDRESS: Address = '0x8453000000000000000000000000000000000001';
export const B20_FACTORY_ADDRESS: Address = '0xB20f000000000000000000000000000000000000';

/** PausableFeature ordinals. TRANSFER gates transfer, transferFrom and the memo'd variants. */
export const PAUSABLE_FEATURE = { TRANSFER: 0, MINT: 1, BURN: 2, SEIZE: 3 } as const;

/**
 * Policy scopes a transfer consults: keccak256 of each name (B20Constants.sol).
 * A scope that was never assigned reads as policy 0, ALWAYS_ALLOW.
 */
export const TRANSFER_SENDER_POLICY: Hex =
  '0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5';
export const TRANSFER_RECEIVER_POLICY: Hex =
  '0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363';
export const TRANSFER_EXECUTOR_POLICY: Hex =
  '0x10be5173aff2a44e748bd9acd8b19fe34689581398a9db7ba2fb671e786ff7d8';

/** The always-allow sentinel: no compliance check on that scope. */
export const ALWAYS_ALLOW_POLICY = 0n;
