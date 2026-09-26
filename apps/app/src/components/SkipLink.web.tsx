/** Web skip-to-content link, visible when focused (DESIGN section 10). */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-control bg-accent px-4 py-3 text-action text-on-accent focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10"
    >
      Skip to content
    </a>
  );
}
