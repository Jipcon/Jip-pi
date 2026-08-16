/**
 * Type shim for the deep highlight.js entry used by coding-agent's source.
 *
 * The desktop tsconfig maps `@earendil-works/pi-coding-agent` to its source
 * for type resolution; that source imports `highlight.js/lib/index.js`,
 * which ships no declaration file for the deep path. The main bundle never
 * executes this code (desktop only imports SDK types), so a re-export of the
 * package's own types is sufficient.
 */

declare module "highlight.js/lib/index.js" {
	export * from "highlight.js";
	export { default } from "highlight.js";
}
