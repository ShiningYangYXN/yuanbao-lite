/**
 * Interactive config init wizard.
 *
 * Uses @clack/prompts (no hand-rolled readline). Writes to the shared
 * ConfigStore from src/cli/config.ts so the daemon sees the same config.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { getGlobalConfigStore } from "../config.js";
import { printResult, printError } from "../theme.js";

export async function runInitWizard(): Promise<void> {
  p.intro(chalk.cyan("🤖 Yuanbao Lite 配置向导"));
  p.log.message(chalk.dim("首次使用需要配置认证信息 (appKey + appSecret 或 token)"));

  const appKey = await p.text({
    message: chalk.yellow("App Key:"),
    placeholder: "",
    validate: (val) => (!val || !val.trim() ? "App Key 不能为空" : undefined),
  });
  if (p.isCancel(appKey)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const appSecret = await p.text({
    message: chalk.yellow("App Secret:"),
    placeholder: "",
    validate: (val) => (!val || !val.trim() ? "App Secret 不能为空" : undefined),
  });
  if (p.isCancel(appSecret)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const name = await p.text({
    message: chalk.yellow("配置名称 (回车使用 default):"),
    placeholder: "default",
  });
  if (p.isCancel(name)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const profileName = (name as string) || "default";
  const store = getGlobalConfigStore({ autoSave: true });

  if (!store.getProfile(profileName)) {
    store.createProfile(profileName, {
      name: profileName,
      appKey: appKey as string,
      appSecret: appSecret as string,
      logLevel: "info",
    });
  } else {
    store.mergeActiveProfile({
      name: profileName,
      appKey: appKey as string,
      appSecret: appSecret as string,
      logLevel: "info",
    });
  }
  store.switchProfile(profileName);

  p.log.success(chalk.green(`✓ 配置已保存到: ${store.getConfigDir()}/config.json`));
  p.outro(chalk.dim("运行 yb-cli daemon start 启动后台 daemon"));

  printResult(`档案 ${profileName} 已就绪`);
  if (!process.env.YB_DAEMON_CHILD) {
    printError("提示: 如需让新配置生效，请重启 daemon (yb-cli daemon stop && yb-cli daemon start)");
  }
}
