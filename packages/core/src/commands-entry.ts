/**
 * Dedicated subpath entry for the command system.
 *
 * Importing from `yuanbao-lite/commands` will pull in the full command-system
 * graph (registry + 53 handlers + their transitive dependencies). This is
 * intentional — users who need the runtime `CommandSystem` class explicitly
 * opt into this cost.
 *
 * Browser callers that disable commands (`config.commands = false`) and
 * never import from this subpath will get a tree-shaken bundle that
 * excludes the entire command-system graph.
 *
 * @example
 * ```typescript
 * import { CommandSystem } from "yuanbao-lite/commands";
 *
 * const cs = new CommandSystem();
 * cs.register({ name: "hello", handler: async () => ({ handled: true, reply: "hi" }) });
 * ```
 */

export { CommandSystem } from "./commands/registry.js";
export type {
  CommandContext,
  CommandDefinition,
  CommandResult,
  CommandSystemConfig,
} from "./commands/types.js";
