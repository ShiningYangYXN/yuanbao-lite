/**
 * Config loading and initialization.
 *
 * Self-contained — no dependency on src/cli/config.ts.
 * Reads/writes ~/.yuanbao-lite/config.json directly.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Local types ───

export interface CliProfile {
  name?: string;
  appKey?: string;
  appSecret?: string;
  token?: string;
  apiDomain?: string;
  wsUrl?: string;
  logLevel?: string;
  stickerDir?: string;
  downloadDir?: string;
  prompt?: string;
  llmProvider?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmSystemPrompt?: string;
  llmEnabled?: boolean;
}

export interface CliConfigData {
  version: number;
  activeProfile: string;
  profiles: Record<string, CliProfile>;
  global?: Record<string, unknown>;
}

export type ConfigOptions = {
  configPath?: string;
  profile?: string;
};

const DEFAULT_CONFIG_DIR = join(homedir(), ".yuanbao-lite");
const DEFAULT_CONFIG_FILE = "config.json";

function getConfigPath(options: ConfigOptions = {}): string {
  if (options.configPath) {
    // options.configPath points to the config JSON file itself
    return options.configPath;
  }
  return join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
}

function readConfig(path: string): CliConfigData | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as CliConfigData;
  } catch {
    return null;
  }
}

function writeConfig(path: string, data: CliConfigData): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Load config from disk. Exits with error if no credentials configured.
 */
export function loadConfig(options: ConfigOptions = {}): {
  profile: CliProfile;
  globalConfig: Record<string, unknown>;
} {
  const configPath = getConfigPath(options);
  const data = readConfig(configPath);

  if (!data) {
    p.cancel(chalk.red("❌ 未找到配置文件，请先运行 config init 初始化。"));
    process.exit(1);
  }

  const profileName = options.profile || data.activeProfile || "default";
  const profile = (data.profiles?.[profileName] ?? {}) as CliProfile;

  const hasCreds = (profile.appKey && profile.appSecret) || profile.token;
  if (!hasCreds) {
    p.cancel(chalk.red("❌ 配置档案未设置认证信息，请先配置 appKey/appSecret 或 token。"));
    process.exit(1);
  }

  return { profile, globalConfig: (data.global ?? {}) as Record<string, unknown> };
}

/**
 * Get the list of profile names.
 */
export function getProfileNames(configPath?: string): string[] {
  const data = readConfig(configPath ?? getConfigPath());
  return data ? Object.keys(data.profiles) : [];
}

/**
 * Get a specific profile by name.
 */
export function getProfile(name: string, configPath?: string): CliProfile | undefined {
  const data = readConfig(configPath ?? getConfigPath());
  return data?.profiles?.[name];
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(configPath?: string): string {
  const data = readConfig(configPath ?? getConfigPath());
  return data?.activeProfile || "default";
}

/**
 * Save the active profile.
 */
function saveProfile(profile: CliProfile, configPath?: string): void {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path) ?? {
    version: 1,
    activeProfile: profile.name || "default",
    profiles: {},
    global: {},
  };
  if (!data.profiles) data.profiles = {};
  if (!data.global) data.global = {};
  data.profiles[profile.name || "default"] = profile;
  data.activeProfile = profile.name || "default";
  writeConfig(path, data);
}

/**
 * Merge active profile with partial.
 */
export function mergeActiveProfile(
  partial: Partial<CliProfile>,
  configPath?: string,
): void {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path) ?? {
    version: 1,
    activeProfile: "default",
    profiles: {},
    global: {},
  };
  if (!data.profiles) data.profiles = {};
  const name = data.activeProfile || "default";
  data.profiles[name] = { ...data.profiles[name], ...partial, name };
  writeConfig(path, data);
}

/**
 * Switch to a different profile.
 */
export function switchProfile(name: string, configPath?: string): boolean {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path);
  if (!data || !data.profiles?.[name]) return false;
  data.activeProfile = name;
  writeConfig(path, data);
  return true;
}

/**
 * Create a new profile.
 */
export function createProfile(
  name: string,
  profile: Partial<CliProfile>,
  configPath?: string,
): void {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path) ?? {
    version: 1,
    activeProfile: name,
    profiles: {},
    global: {},
  };
  if (!data.profiles) data.profiles = {};
  data.profiles[name] = { name, ...profile };
  data.activeProfile = name;
  writeConfig(path, data);
}

/**
 * Delete a profile. Cannot delete active profile.
 */
export function deleteProfile(name: string, configPath?: string): boolean {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path);
  if (!data || !data.profiles?.[name]) return false;
  if (data.activeProfile === name) return false;
  delete data.profiles[name];
  writeConfig(path, data);
  return true;
}

/**
 * Set a single config key on the active profile.
 */
export function setConfigKey(key: string, value: string, configPath?: string): void {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path) ?? {
    version: 1,
    activeProfile: "default",
    profiles: {},
    global: {},
  };
  if (!data.profiles) data.profiles = {};
  const name = data.activeProfile || "default";
  if (!data.profiles[name]) data.profiles[name] = { name };
  (data.profiles[name] as Record<string, unknown>)[key] = value;
  writeConfig(path, data);
}

/**
 * Set a global config key.
 */
export function setGlobalKey(key: string, value: unknown, configPath?: string): void {
  const path = configPath ?? getConfigPath();
  const data = readConfig(path) ?? {
    version: 1,
    activeProfile: "default",
    profiles: {},
    global: {},
  };
  if (!data.global) data.global = {};
  (data.global as Record<string, unknown>)[key] = value;
  writeConfig(path, data);
}

/**
 * Interactive guided setup — uses Clack to collect appKey, appSecret, name.
 */
export async function initConfig(options: ConfigOptions = {}): Promise<boolean> {
  const path = getConfigPath(options);
  const existing = readConfig(path);
  const defaultProfile = {
    version: 1,
    activeProfile: "default",
    profiles: {},
    global: {},
  };
  const data = existing ?? defaultProfile;
  if (!data.profiles) data.profiles = {};
  if (!data.global) data.global = {};

  p.intro(chalk.cyan("🤖 Yuanbao Lite 配置向导"));
  p.outro(chalk.dim("首次使用需要配置认证信息"));

  const appKey = await p.text({
    message: chalk.yellow("App Key:"),
    placeholder: "",
    validate: (val) => (!val || !val.trim() ? "App Key 不能为空" : undefined),
  });
  if (p.isCancel(appKey)) { p.cancel("已取消配置"); process.exit(0); }

  const appSecret = await p.text({
    message: chalk.yellow("App Secret:"),
    placeholder: "",
    validate: (val) => (!val || !val.trim() ? "App Secret 不能为空" : undefined),
  });
  if (p.isCancel(appSecret)) { p.cancel("已取消配置"); process.exit(0); }

  const name = await p.text({
    message: chalk.yellow("配置名称 (回车使用 default):"),
    placeholder: "default",
  });
  if (p.isCancel(name)) { p.cancel("已取消配置"); process.exit(0); }

  const profileName = name || "default";
  //data.profiles[profileName] = { name: profileName, appKey, appSecret, logLevel: "info" };

  data.activeProfile = profileName;

  if (!existsSync(DEFAULT_CONFIG_DIR)) mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  writeConfig(path, data);

  p.log.success(chalk.green(`✅ 配置已保存到: ${path}`));
  p.outro(chalk.dim("可以随时使用 config set 修改配置"));

  return true;
}
