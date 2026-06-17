/**
 * Config facade for cli — RE-EXPORTS the existing ConfigStore from
 * `src/cli/config.ts` so we share one implementation across both CLIs.
 *
 * No duplication: cli depends on the same singleton ConfigStore that
 * the daemon and the bot use.
 */

export {
  ConfigStore,
  getGlobalConfigStore,
  resetGlobalConfigStore,
  normalizePath,
  normalizeDir,
} from "../shared/config.js";

export type {
  CliProfile,
  CliConfigData,
} from "../shared/config.js";
