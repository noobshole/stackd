'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchBaseNetwork } from '@/lib/verify';

/**
 * The Base network the API pays on, or null while Base payouts are off.
 *
 * The API is the source of truth, so the site never offers Base when a
 * submission would be refused for it. A failed health check counts as off:
 * Solana keeps working whatever happens here.
 */
export function useBaseNetwork() {
  const query = useQuery({
    queryKey: ['base-network'],
    queryFn: fetchBaseNetwork,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { network: query.data ?? null, loading: query.isPending };
}
