/**
 * Type declarations for modules without bundled types.
 */

declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  /**
   * Factory that returns a MarkedExtension for terminal/ANSI rendering.
   * This is a NAMED export — the default export is the Renderer class.
   */
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;

  /** The Renderer class (default export). Not used directly. */
  const Renderer: new (
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ) => unknown;
  export default Renderer;
}
