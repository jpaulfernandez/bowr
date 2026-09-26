// Account-scoped resources register a disposer here. On sign-out or account change
// every disposer runs, so uploads, object URLs and drafts never outlive the account.
const disposers = new Set<() => void>();

export function onAccountDispose(dispose: () => void): () => void {
  disposers.add(dispose);
  return () => disposers.delete(dispose);
}

export function disposeAccountResources(): void {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // A failing disposer must not block sign-out.
    }
  }
}
