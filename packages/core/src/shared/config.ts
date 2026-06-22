/**
 * CLI configuration store — persistent JSON config with path normalization
 * and guided setup.
 *
 * Features:
 *   - JSON-based config file at ~/.yuanbao-lite/config.json
 *   - No trailing slashes on directory paths
 *   - Auto-load on startup, auto-save on mutation
 *   - Guided config creation when no config exists
 *   - Multi-profile support
 *   - Schema validation with sensible defaults
 *
 * @module cli/config
 */

import {
  getDefaultPersistenceAdapter,
  getDefaultPersistenceDir,
  joinPath,
  getNodeModules,
} from "../access/persistence/adapter.js";
// LlmProviderType removed — use string for provider names
type LlmProviderType = string;

// ─── Types ───

export type CliProfile = {
  /** Profile name */
  name: string;
  /** App key for authentication */
  appKey?: string;
  /** App secret for authentication */
  appSecret?: string;
  /** Pre-signed token (alternative to appKey+appSecret) */
  token?: string;
  /** API domain override */
  apiDomain?: string;
  /** WebSocket URL override */
  wsUrl?: string;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Sticker directory (no trailing slash) */
  stickerDir?: string;
  /** Download directory (no trailing slash) */
  downloadDir?: string;
  /** Custom prompt string */
  prompt?: string;
  /** LLM provider type */
  llmProvider?: LlmProviderType;
  /** LLM API key */
  llmApiKey?: string;
  /** LLM base URL */
  llmBaseUrl?: string;
  /** LLM model name */
  llmModel?: string;
  /** LLM system prompt */
  llmSystemPrompt?: string;
  /** Whether LLM is enabled */
  llmEnabled?: boolean;
  /** Whether LLM auto-reply is on (default: true, only responds to @mentions in groups) */
  llmAutoReply?: boolean;
  /** User-defined system prompt appended after the default */
  userSystemPrompt?: string;
  /** Default chat target */
  defaultTarget?: string;
  /** Default chat mode: dm | group */
  defaultChatMode?: "dm" | "group";
};

export type CliConfigData = {
  /** Config file version */
  version: number;
  /** Currently active profile name */
  activeProfile: string;
  /** Named profiles */
  profiles: Record<string, CliProfile>;
  /** Global settings (apply to all profiles) */
  global?: {
    /** Default log level */
    logLevel?: "debug" | "info" | "warn" | "error";
    /** Default download directory */
    downloadDir?: string;
    /** Default sticker directory */
    stickerDir?: string;
    /** Config directory path */
    configDir?: string;
  };
};

// ─── Constants ───

/**
 * Default config directory — lazily resolved on first access.
 *
 * Cannot be resolved at module load time because `getDefaultPersistenceDir()`
 * requires `nodeModules` to be loaded (via top-level await in adapter.ts),
 * which may not have completed when this module is first imported.
 */
function getDefaultConfigDir(): string {
  return getDefaultPersistenceDir();
}
const DEFAULT_CONFIG_FILE = "config.json";
const CURRENT_VERSION = 1;

// ─── Path normalization ───

/**
 * Normalize a path: resolve to absolute and remove trailing slashes.
 * Empty/undefined paths are returned as undefined.
 */
export function normalizePath(p: string | undefined): string | undefined {
  if (!p || !p.trim()) return undefined;
  // Resolve to absolute path and remove trailing slashes.
  // Uses node:path.resolve under Node; under browser, returns the path
  // as-is (no filesystem-relative resolution possible).
  const path = getNodeModules().path;
  let normalized = path ? path.resolve(p) : p;
  // Remove trailing slashes (but keep root "/")
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || undefined;
}

/**
 * Normalize a directory path, ensuring no trailing slash.
 * Returns undefined for empty/whitespace-only paths.
 */
export function normalizeDir(p: string | undefined): string | undefined {
  return normalizePath(p);
}

// ─── ConfigStore ───

export class ConfigStore {
  private configDir: string;
  private configPath: string;
  private data: CliConfigData;
  private autoSave: boolean;

  constructor(options?: { configDir?: string; autoSave?: boolean }) {
    this.configDir = normalizePath(options?.configDir) || getDefaultConfigDir();
    this.configPath = joinPath(this.configDir, DEFAULT_CONFIG_FILE);
    this.autoSave = options?.autoSave ?? true;
    this.data = this.createDefaultData();

    // Load existing config; auto-create the file if it doesn't exist
    const loaded = this.load();
    if (!loaded) {
      this.save();
    }
  }

  // ─── Read API ───

  /** Get the entire config data object. */
  getData(): CliConfigData {
    return { ...this.data };
  }

  /** Get the active profile. */
  getActiveProfile(): CliProfile {
    return (
      this.data.profiles[this.data.activeProfile] ||
      this.createDefaultProfile("default")
    );
  }

  /** Get the active profile name. */
  getActiveProfileName(): string {
    return this.data.activeProfile;
  }

  /** Get a specific profile by name. */
  getProfile(name: string): CliProfile | undefined {
    return this.data.profiles[name];
  }

  /** Get all profile names. */
  getProfileNames(): string[] {
    return Object.keys(this.data.profiles);
  }

  /** Get a config value from the active profile. */
  get<K extends keyof CliProfile>(key: K): CliProfile[K] | undefined {
    const profile = this.getActiveProfile();
    return profile[key];
  }

  /** Get a global setting. */
  getGlobal<K extends keyof NonNullable<CliConfigData["global"]>>(
    key: K,
  ): NonNullable<CliConfigData["global"]>[K] | undefined {
    return this.data.global?.[key];
  }

  /** Get the config directory path (no trailing slash). */
  getConfigDir(): string {
    return this.configDir;
  }

  /** Check if the config file exists. */
  exists(): boolean {
    return getDefaultPersistenceAdapter().exists(this.configPath);
  }

  /** Check if the active profile has credentials configured. */
  hasCredentials(): boolean {
    const profile = this.getActiveProfile();
    return Boolean((profile.appKey && profile.appSecret) || profile.token);
  }

  // ─── Write API ───

  /** Set a config value on the active profile. */
  set<K extends keyof CliProfile>(key: K, value: CliProfile[K]): void {
    const profileName = this.data.activeProfile;
    if (!this.data.profiles[profileName]) {
      this.data.profiles[profileName] = this.createDefaultProfile(profileName);
    }

    // Normalize paths
    if (
      (key === "stickerDir" || key === "downloadDir") &&
      typeof value === "string"
    ) {
      (this.data.profiles[profileName] as Record<string, unknown>)[key] =
        normalizeDir(value);
    } else {
      (this.data.profiles[profileName] as Record<string, unknown>)[key] = value;
    }

    this.maybeAutoSave();
  }

  /** Set a global setting. */
  setGlobal<K extends keyof NonNullable<CliConfigData["global"]>>(
    key: K,
    value: NonNullable<CliConfigData["global"]>[K],
  ): void {
    if (!this.data.global) this.data.global = {};
    this.data.global[key] = value;
    this.maybeAutoSave();
  }

  /** Switch to a different profile. */
  switchProfile(name: string): boolean {
    if (!this.data.profiles[name]) return false;
    this.data.activeProfile = name;
    this.maybeAutoSave();
    return true;
  }

  /** Create a new profile. */
  createProfile(name: string, profile?: Partial<CliProfile>): CliProfile {
    const newProfile: CliProfile = {
      ...this.createDefaultProfile(name),
      ...profile,
    };
    // Normalize directory paths
    if (newProfile.stickerDir)
      newProfile.stickerDir = normalizeDir(newProfile.stickerDir);
    if (newProfile.downloadDir)
      newProfile.downloadDir = normalizeDir(newProfile.downloadDir);

    this.data.profiles[name] = newProfile;
    this.maybeAutoSave();
    return newProfile;
  }

  /** Delete a profile. Cannot delete the active profile. */
  deleteProfile(name: string): boolean {
    if (name === this.data.activeProfile) return false;
    if (!this.data.profiles[name]) return false;
    delete this.data.profiles[name];
    this.maybeAutoSave();
    return true;
  }

  /** Merge a partial profile into the active profile. */
  mergeActiveProfile(partial: Partial<CliProfile>): void {
    const profileName = this.data.activeProfile;
    if (!this.data.profiles[profileName]) {
      this.data.profiles[profileName] = this.createDefaultProfile(profileName);
    }
    Object.assign(this.data.profiles[profileName], partial);
    // Normalize paths again
    const profile = this.data.profiles[profileName];
    if (profile.stickerDir)
      profile.stickerDir = normalizeDir(profile.stickerDir);
    if (profile.downloadDir)
      profile.downloadDir = normalizeDir(profile.downloadDir);
    this.maybeAutoSave();
  }

  // ─── Persistence ───

  /** Save config to disk. */
  save(): boolean {
    try {
      const adapter = getDefaultPersistenceAdapter();
      adapter.write(this.configPath, JSON.stringify(this.data, null, 2));
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Load config from disk. */
  load(): boolean {
    try {
      const adapter = getDefaultPersistenceAdapter();
      if (!adapter.exists(this.configPath)) {
        return false;
      }
      const raw = adapter.read(this.configPath);
      const parsed = JSON.parse(raw) as CliConfigData;

      // Validate structure — if malformed, treat as corrupt
      if (!parsed || typeof parsed !== "object" || !parsed.profiles) {
        throw new Error("malformed config.json");
      }

      // Version migration
      if (parsed.version !== CURRENT_VERSION) {
        this.data = this.migrate(parsed);
      } else {
        this.data = parsed;
      }

      // Normalize all directory paths
      for (const profile of Object.values(this.data.profiles)) {
        if (profile.stickerDir)
          profile.stickerDir = normalizeDir(profile.stickerDir);
        if (profile.downloadDir)
          profile.downloadDir = normalizeDir(profile.downloadDir);
      }
      if (this.data.global?.configDir)
        this.data.global.configDir = normalizeDir(this.data.global.configDir);

      return true;
    } catch (err) {
      // File corrupt or unreadable — overwrite with default config
      this.data = this.createDefaultData();
      this.save();
      return false;
    }
  }

  // ─── Guided setup ───

  /**
   * Check if guided setup is needed and return the prompts.
   * Returns null if credentials are already configured.
   */
  needsSetup(): boolean {
    return !this.hasCredentials();
  }

  /**
   * Apply setup answers to the config.
   */
  applySetupAnswers(answers: {
    appKey: string;
    appSecret: string;
    name?: string;
  }): void {
    this.mergeActiveProfile({
      name: answers.name || "default",
      appKey: answers.appKey,
      appSecret: answers.appSecret,
    });
  }

  // ─── Export to CliConfig ───

  /**
   * Convert the active profile to the legacy CliConfig format.
   */
  toCliConfig(): Record<string, unknown> {
    const profile = this.getActiveProfile();
    const globalConfig = this.data.global;
    return {
      appKey: profile.appKey,
      appSecret: profile.appSecret,
      token: profile.token,
      apiDomain: profile.apiDomain,
      wsUrl: profile.wsUrl,
      logLevel: profile.logLevel || globalConfig?.logLevel,
      stickerDir: profile.stickerDir || globalConfig?.stickerDir,
      downloadDir: profile.downloadDir || globalConfig?.downloadDir,
      prompt: profile.prompt,
      llmProvider: profile.llmProvider,
      llmApiKey: profile.llmApiKey,
      llmBaseUrl: profile.llmBaseUrl,
      llm: profile.llmEnabled
        ? {
            enabled: true,
            model: profile.llmModel,
            systemPrompt: profile.llmSystemPrompt,
            provider: profile.llmProvider,
          }
        : undefined,
    };
  }

  // ─── Internal ───

  private createDefaultData(): CliConfigData {
    return {
      version: CURRENT_VERSION,
      activeProfile: "default",
      profiles: {
        default: this.createDefaultProfile("default"),
      },
      global: {
        downloadDir: normalizeDir(
          joinPath(
            getDefaultPersistenceDir(),
            "..",
            "Downloads",
            "yuanbao-lite",
          ),
        ),
      },
    };
  }

  private createDefaultProfile(name: string): CliProfile {
    return {
      name,
      logLevel: "info",
    };
  }

  private migrate(old: CliConfigData): CliConfigData {
    // For now, just update the version
    return { ...old, version: CURRENT_VERSION };
  }

  private maybeAutoSave(): void {
    if (this.autoSave) {
      this.save();
    }
  }
}

// ─── Singleton ───

let globalConfigStore: ConfigStore | null = null;

export function getGlobalConfigStore(options?: {
  configDir?: string;
  autoSave?: boolean;
}): ConfigStore {
  if (!globalConfigStore) {
    globalConfigStore = new ConfigStore(options);
  }
  return globalConfigStore;
}

export function resetGlobalConfigStore(): void {
  globalConfigStore = null;
}
