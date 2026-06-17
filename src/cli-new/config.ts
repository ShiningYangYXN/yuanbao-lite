/**
 * Config facade for cli-new — RE-EXPORTS the existing ConfigStore from
 * `src/cli/config.ts` so we share one implementation across both CLIs.
 *
 * No duplication: cli-new depends on the same singleton ConfigStore that
 * the daemon and the bot use.
 */

export {
  ConfigStore,
  getGlobalConfigStore,
  resetGlobalConfigStore,
  normalizePath,
  normalizeDir,
} from "../cli/config.js";

export type {
  CliProfile,
  CliConfigData,
} from "../cli/config.js";
