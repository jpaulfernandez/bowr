// Web session storage (ARCHITECTURE section 4.2): the session is tab-scoped in
// sessionStorage, so closing the tab ends it. Only the short-lived PKCE code
// verifier uses localStorage, because a magic link usually opens in a new tab of
// the same browser; it is removed once the code is exchanged.
function safe<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

const isVerifier = (key: string) => key.endsWith('-code-verifier');
const storeFor = (key: string): Storage => (isVerifier(key) ? window.localStorage : window.sessionStorage);

export const authStorage = {
  getItem: (key: string) => safe(() => storeFor(key).getItem(key), null),
  setItem: (key: string, value: string) => safe(() => storeFor(key).setItem(key, value), undefined),
  removeItem: (key: string) => safe(() => storeFor(key).removeItem(key), undefined),
};

/** Non-sensitive values that must survive the magic-link round trip. */
export const durableStorage = {
  getItem: (key: string) => safe(() => window.localStorage.getItem(key), null),
  setItem: (key: string, value: string) => safe(() => window.localStorage.setItem(key, value), undefined),
  removeItem: (key: string) => safe(() => window.localStorage.removeItem(key), undefined),
};
