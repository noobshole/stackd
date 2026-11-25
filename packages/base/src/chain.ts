/**
 * Onchain reads a payout depends on. No secrets; takes a client.
 *
 * Everything is read fresh for each payout: the multiplier changes with
 * dividends, the issuer can pause transfers, and a policy's membership can
 * change at any block.
 */

import type { Address, PublicClient } from 'viem';
import {
  ALWAYS_ALLOW_POLICY,
  b20Abi,
  PAUSABLE_FEATURE,
  POLICY_REGISTRY_ADDRESS,
  policyRegistryAbi,
  TRANSFER_EXECUTOR_POLICY,
  TRANSFER_RECEIVER_POLICY,
  TRANSFER_SENDER_POLICY,
} from './abi';

export interface TokenState {
  decimals: number;
  /** uiMultiplier(), WAD-scaled. */
  multiplierWad: bigint;
  /** The issuer has paused the TRANSFER feature. */
  transfersPaused: boolean;
  /** The treasury passes the sender and executor policies. */
  treasuryAllowed: boolean;
  /** The recipient passes the receiver policy. */
  recipientAllowed: boolean;
  treasuryBalance: bigint;
  /** effectiveAt() of a scheduled multiplier change, in unix seconds. Null when none or unreadable. */
  multiplierChangeAt: bigint | null;
}

export async function readTokenState(
  client: Pick<PublicClient, 'readContract'>,
  token: Address,
  treasury: Address,
  recipient: Address,
): Promise<TokenState> {
  const read = <const F extends 'decimals' | 'uiMultiplier' | 'effectiveAt'>(functionName: F) =>
    client.readContract({ address: token, abi: b20Abi, functionName });
  const policy = (scope: `0x${string}`) =>
    client.readContract({ address: token, abi: b20Abi, functionName: 'policyId', args: [scope] });

  const [decimals, multiplierWad, transfersPaused, senderPolicy, receiverPolicy, executorPolicy, treasuryBalance, changeAt] =
    await Promise.all([
      read('decimals'),
      read('uiMultiplier'),
      client.readContract({
        address: token,
        abi: b20Abi,
        functionName: 'isPaused',
        args: [PAUSABLE_FEATURE.TRANSFER],
      }),
      policy(TRANSFER_SENDER_POLICY),
      policy(TRANSFER_RECEIVER_POLICY),
      policy(TRANSFER_EXECUTOR_POLICY),
      client.readContract({ address: token, abi: b20Abi, functionName: 'balanceOf', args: [treasury] }),
      // Supplementary: a token without a schedule reads 0. Unreadable is not fatal.
      read('effectiveAt').catch(() => null),
    ]);

  // Ask the registry exactly what the token will ask it at transfer time.
  // Policy 0 is ALWAYS_ALLOW and needs no call.
  const authorized = (policyId: bigint, account: Address): Promise<boolean> =>
    policyId === ALWAYS_ALLOW_POLICY
      ? Promise.resolve(true)
      : client.readContract({
          address: POLICY_REGISTRY_ADDRESS,
          abi: policyRegistryAbi,
          functionName: 'isAuthorized',
          args: [policyId, account],
        });

  const [senderOk, executorOk, receiverOk] = await Promise.all([
    authorized(senderPolicy, treasury),
    authorized(executorPolicy, treasury),
    authorized(receiverPolicy, recipient),
  ]);

  return {
    decimals,
    multiplierWad,
    transfersPaused,
    treasuryAllowed: senderOk && executorOk,
    recipientAllowed: receiverOk,
    treasuryBalance,
    multiplierChangeAt: changeAt && changeAt > 0n ? changeAt : null,
  };
}
