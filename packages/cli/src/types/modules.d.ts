/**
 * Type declarations for modules without bundled types.
 */

declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  const markedTerminal: () => MarkedExtension;
  export default markedTerminal;
}

