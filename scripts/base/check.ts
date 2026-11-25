/**
 * Read-only check of the Base stocks Stackd pays out, against Base mainnet.
 *
 *   npm run base:check
 *
 * For each stock in packages/base/src/stocks.ts: symbol() matches the ticker
 * (catches a wrongly copied address), decimals, multiplier, transfer pause,
 * transfer policies, and the Chainlink feed's price and age. With
 * BASE_TREASURY_ADDRESS set, also the treasury's ETH and stock balances.
 *
 * Sends nothing and needs no secret. Uses BASE_RPC_URL when BASE_NETWORK is
 * mainnet, otherwise BASE_MAINNET_RPC_URL or the public endpoint.
 */

import {
  b20Abi,
  BASE_STOCKS,
  feedPriceUsd,
  getBasePriceClient,
  newBaseKey,
  PAUSABLE_FEATURE,
  POLICY_REGISTRY_ADDRESS,
  policyRegistryAbi,
  rawToShares,
  readFeedRound,
  TRANSFER_EXECUTOR_POLICY,
  TRANSFER_RECEIVER_POLICY,
  TRANSFER_SENDER_POLICY,
  WAD,
} from '@stackd/base/server';
import { fail } from '../dbc/_shared.js';

const mask = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (s: number) => (s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

async function main(): Promise<void> {
  const client = getBasePriceClient();
  const nowS = Math.floor(Date.now() / 1000);
  let problems = 0;

  // A never-used address stands in for a new user. If a policy refuses it, the
  // issuer runs an allowlist, and ordinary wallets cannot receive payouts at all.
  const newcomer = newBaseKey().address;
  const admits = (policy: bigint) =>
    policy === 0n
      ? Promise.resolve(true)
      : client.readContract({
          address: POLICY_REGISTRY_ADDRESS,
          abi: policyRegistryAbi,
          functionName: 'isAuthorized',
          args: [policy, newcomer],
        });

  console.log('\n  Base stocks (mainnet)');
  console.log('  =====================');

  for (const stock of BASE_STOCKS) {
    const at = { address: stock.token, abi: b20Abi } as const;
    try {
      const [symbol, decimals, multiplier, paused, sender, receiver, executor, effectiveAt] = await Promise.all([
        client.readContract({ ...at, functionName: 'symbol' }),
        client.readContract({ ...at, functionName: 'decimals' }),
        client.readContract({ ...at, functionName: 'uiMultiplier' }),
        client.readContract({ ...at, functionName: 'isPaused', args: [PAUSABLE_FEATURE.TRANSFER] }),
        client.readContract({ ...at, functionName: 'policyId', args: [TRANSFER_SENDER_POLICY] }),
        client.readContract({ ...at, functionName: 'policyId', args: [TRANSFER_RECEIVER_POLICY] }),
        client.readContract({ ...at, functionName: 'policyId', args: [TRANSFER_EXECUTOR_POLICY] }),
        client.readContract({ ...at, functionName: 'effectiveAt' }).catch(() => null),
      ]);
      const round = await readFeedRound(client, stock.feed);
      const price = feedPriceUsd(round, nowS);

      const open = (await Promise.all([admits(sender), admits(receiver), admits(executor)])).every(Boolean);

      const symbolOk = symbol === stock.ticker;
      if (!symbolOk || paused || price == null || !open) problems++;

      const policies = [sender, receiver, executor].some((p) => p !== 0n)
        ? `policies ${sender}/${receiver}/${executor} (sender/receiver/executor), ` +
          (open ? 'a new wallet passes' : 'A NEW WALLET IS REFUSED: allowlist, payouts cannot reach ordinary wallets')
        : 'no transfer policies';
      const change = effectiveAt && effectiveAt > 0n ? `, multiplier change at ${new Date(Number(effectiveAt) * 1000).toISOString()}` : '';
      const feed = round
        ? `feed $${(Number(round.answer) / 10 ** round.decimals).toFixed(2)} (${ago(nowS - Number(round.updatedAt))} old${price == null ? ', STALE' : ''})`
        : 'feed UNREADABLE';

      console.log(
        `  ${symbolOk ? '✓' : '✗'} ${stock.ticker.padEnd(7)} symbol ${symbol}${symbolOk ? '' : ` (expected ${stock.ticker})`}, ` +
          `${decimals} decimals, multiplier ${(Number(multiplier) / Number(WAD)).toFixed(6)}, ` +
          `${paused ? 'TRANSFERS PAUSED' : 'transfers live'}, ${policies}${change}`,
      );
      console.log(`             ${feed}`);
    } catch (error) {
      problems++;
      console.log(`  ✗ ${stock.ticker.padEnd(7)} unreadable: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  const treasury = process.env.BASE_TREASURY_ADDRESS?.trim() as `0x${string}` | undefined;
  if (treasury) {
    console.log(`\n  Treasury ${mask(treasury)} (mainnet)`);
    const eth = await client.getBalance({ address: treasury });
    console.log(`  · ETH ${(Number(eth) / 1e18).toFixed(6)}`);
    for (const stock of BASE_STOCKS) {
      const at = { address: stock.token, abi: b20Abi } as const;
      const [raw, decimals, multiplier] = await Promise.all([
        client.readContract({ ...at, functionName: 'balanceOf', args: [treasury] }),
        client.readContract({ ...at, functionName: 'decimals' }),
        client.readContract({ ...at, functionName: 'uiMultiplier' }),
      ]);
      console.log(`  · ${stock.ticker.padEnd(7)} ${rawToShares(raw, multiplier, decimals)} shares`);
    }
  }

  console.log(`\n  ${problems ? `${problems} problem(s)` : 'All stocks readable, symbols match, feeds fresh.'}\n`);
  if (problems) process.exitCode = 1;
}

main().catch(fail);
