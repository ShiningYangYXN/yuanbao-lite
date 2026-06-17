/**
 * Core helpers for the new CLI.
 *
 * Bot lifecycle management, config loading, and output utilities.
 *
 * All business logic lives in src/commands/registry.ts (CommandSystem) —
 * this file only handles connection, prompts, and rendering.
 */

export {
  createBotFromProfile,
  withBot,
  type BotOptions,
} from "./bot-helper.js";
export {
  loadConfig,
  initConfig,
  type ConfigOptions,
} from "./config-loader.js";
export {
  printWelcome,
  printStatus,
  printResult,
  printError,
  printSection,
} from "./render.js";
