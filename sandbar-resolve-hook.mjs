// The CLI's package-identity resolve hook (#148).
//
// Re-run Node's ordinary package resolution from inside the executing Sandbar
// package. Package self-resolution then applies this driver's own `exports`
// map, so `sandbar` (and any exported `sandbar/...` subpath) names this copy.
// Everything else keeps its original importer and proceeds untouched.

/** @type {import("node:module").ResolveHook} */
export function resolve(specifier, context, nextResolve) {
  if (specifier === "sandbar" || specifier.startsWith("sandbar/")) {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url });
  }
  return nextResolve(specifier, context);
}
