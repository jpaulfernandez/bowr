/** Every private query key starts with the authenticated user ID. */
export const userKeys = {
  all: (userId: string) => ['user', userId] as const,
  bootstrap: (userId: string) => ['user', userId, 'bootstrap'] as const,
  profile: (userId: string) => ['user', userId, 'profile'] as const,
};
