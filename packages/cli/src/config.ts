/**
 * Config facade for CLI — RE-EXPORTS the ConfigStore from the core package
 * so the CLI shares one implementation with the daemon and the bot.
 *
 * The actual implementation lives in @yuanbao-lite/core (src/shared/config.ts).
 */

export {
  ConfigStore,
  getGlobalConfigStore,
  resetGlobalConfigStore,
  normalizePath,
  normalizeDir,
} from "@yuanbao-lite/core/shared/config";

export type {
  CliProfile,
  CliConfigData,
} from "@yuanbao-lite/core/shared/config";
