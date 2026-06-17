/**
 * Config loading and initialization.
 *
 * Uses ConfigStore from src/cli/config.ts (shared with old CLI) for
 * reading/writing ~/.yuanbao-lite/config.json.
 *
 * Supports interactive guided setup via Clack prompts.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import chalk from "chalk";
import {
  ConfigStore,
  getGlobalConfigStore,
  type CliProfile,
} from "../../cli/config.js";

export type ConfigOptions = {
  configPath?: string;
  profile?: string;
};

/**
 * Load config from disk. Returns the profile and global config.
 * Exits with error if no credentials are configured.
 */
export function loadConfig(options: ConfigOptions = {}): {
  profile: CliProfile;
  globalConfig: Record<string, unknown>;
} {
  const store = new ConfigStore({
    configDir: options.configPath ? join(options.configPath, "..") : undefined,
    autoSave: false,
  });

  if (!store.exists()) {
    p.cancel("❌ 未找到配置文件，请先运行 config init 初始化。");
    process.exit(1);
  }

  const profileName = options.profile ?? store.getActiveProfileName();
  const profile = store.getProfile(profileName);

  if (!profile) {
    p.cancel(`❌ 配置文件不存在: ${profileName}`);
    process.exit(1);
  }

  // Check credentials
  const hasCreds =
    (profile.appKey && profile.appSecret) || profile.token;
  if (!hasCreds) {
    p.cancel("❌ 配置文件未设置认证信息，请先配置 appKey/appSecret 或 token。");
    process.exit(1);
  }

  const globalConfig = store.getData().global ?? {};
  return { profile, globalConfig: globalConfig as Record<string, unknown> };
}

/**
 * Interactive guided setup — uses Clack to collect appKey, appSecret, name.
 */
export async function initConfig(): Promise<boolean> {
  const store = getGlobalConfigStore();

  p.intro(chalk.cyan("🤖 Yuanbao Lite 配置向导"));
  p.outro(chalk.dim("首次使用需要配置认证信息"));

  const appKey = await p.text({
    message: "App Key:",
    placeholder: "",
    validate: (val) => {
      if (!val || !val.trim()) return "App Key 不能为空";
    },
  });

  if (p.isCancel(appKey)) {
    p.cancel("已取消配置");
    process.exit(0);
  }

  const appSecret = await p.text({
    message: "App Secret:",
    placeholder: "",
    validate: (val) => {
      if (!val || !val.trim()) return "App Secret 不能为空";
    },
  });

  if (p.isCancel(appSecret)) {
    p.cancel("已取消配置");
    process.exit(0);
  }

  const name = await p.text({
    message: "配置名称 (回车使用 default):",
    placeholder: "default",
  });

  if (p.isCancel(name)) {
    p.cancel("已取消配置");
    process.exit(0);
  }

  store.applySetupAnswers({
    appKey,
    appSecret,
    name: (name as string) || "default",
  });

  // Ensure config dir exists and save
  const configDir = store.getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  store.save();

  p.log.success(
    chalk.green(`✅ 配置已保存到: ${configDir}/config.json`),
  );
  p.outro(chalk.dim("可以随时使用 config set 修改配置"));

  return true;
}
