import { QueryClient } from '@tanstack/react-query';
import { ApiError, StaleAccountError } from './errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof StaleAccountError) return false;
          if (error instanceof ApiError && !error.retryable) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
