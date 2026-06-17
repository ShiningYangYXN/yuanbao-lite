/**
 * Bot lifecycle management.
 *
 * Creates bot instances from profiles and provides a `withBot` wrapper
 * that handles connect → run → disconnect with a timeout.
 *
 * Reuses YuanbaoBot from src/index.ts (same as old CLI).
 */

import type { YuanbaoBot } from "../../index.js";
import type { CliProfile } from "../../cli/config.js";
import { setLogLevel } from "../../logger.js";

export type BotOptions = {
  logLevel?: string;
  downloadDir?: string;
  stickerDir?: string;
};

/**
 * Create a bot instance from a profile and optional global config.
 */
export function createBotFromProfile(
  profile: CliProfile,
  options?: BotOptions,
): YuanbaoBot {
  const logLevel =
    (profile.logLevel || options?.logLevel || "info") as
    | "debug"
    | "info"
    | "warn"
    | "error";
  setLogLevel(logLevel);

  const config: Record<string, unknown> = {
    appKey: profile.appKey,
    appSecret: profile.appSecret,
    token: profile.token,
    apiDomain: profile.apiDomain,
    wsUrl: profile.wsUrl,
    logLevel,
  };

  return new YuanbaoBot(config);
}

/**
 * Connect bot → run function → disconnect, with timeout.
 */
export async function withBot<T>(
  profile: CliProfile,
  options: BotOptions | undefined,
  fn: (bot: YuanbaoBot) => Promise<T>,
): Promise<T> {
  const bot = createBotFromProfile(profile, options);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.stop();
      reject(new Error("连接超时 (30秒)"));
    }, 30_000);

    bot.on("ready", async () => {
      clearTimeout(timer);
      try {
        const result = await fn(bot);
        bot.stop();
        resolve(result);
      } catch (err) {
        bot.stop();
        reject(err);
      }
    });

    bot.start().catch(reject);
  });
}
