import { BootstrapResponse } from '@bowr/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { userKeys } from './query-keys';
import { useSession } from './session';

export function useBootstrap() {
  const { userId } = useSession();
  return useQuery({
    queryKey: userKeys.bootstrap(userId ?? 'anonymous'),
    queryFn: ({ signal }) => apiRequest('/bootstrap', { schema: BootstrapResponse.shape.data, signal }),
    enabled: userId !== null,
    staleTime: 30_000,
  });
}
