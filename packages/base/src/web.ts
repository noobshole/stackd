/**
 * The browser's slice of @stackd/base: which stocks pay on Base, and whether
 * an address can be paid. It leaves out the network module, whose viem chain
 * list the website has no use for.
 */

export { BASE_STOCKS, baseStock, type BaseStock } from './stocks';
export { parseBaseAddress } from './address';
