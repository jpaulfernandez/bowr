/** Web skip-to-content link, visible when focused (DESIGN section 10). */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="absolute left-2 top-2 z-10 -translate-y-24 rounded-control bg-accent px-4 py-3 text-action text-on-accent focus:translate-y-0"
    >
      Skip to content
    </a>
  );
}
