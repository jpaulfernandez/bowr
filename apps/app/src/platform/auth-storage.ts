// Native placeholder: memory-only session until the phase-8 secure adapter.
const memory = new Map<string, string>();

export const authStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

export const durableStorage = authStorage;
