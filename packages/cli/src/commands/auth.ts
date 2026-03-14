import { Command } from "commander";
import chalk from "chalk";
import { setConfig, getConfig } from "../lib/config.js";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage authentication");

  auth
    .command("login")
    .description("Log in to ClawForge")
    .action(() => {
      console.log(
        chalk.yellow("Browser OAuth not yet implemented.\n") +
        `Use: ${chalk.cyan("clawforge auth token <token>")} to set your API token.`
      );
    });

  auth
    .command("token <t>")
    .description("Store an API token")
    .action((t: string) => {
      setConfig("token", t);
      console.log(chalk.green("Token saved successfully."));
    });

  auth
    .command("set-url <url>")
    .description("Set the API server URL")
    .action((url: string) => {
      setConfig("api_url", url);
      console.log(chalk.green(`API URL set to ${chalk.cyan(url)}`));
    });

  auth
    .command("status")
    .description("Show current auth status")
    .action(() => {
      const config = getConfig();
      console.log(chalk.bold("ClawForge Auth Status\n"));
      console.log(`  API URL:  ${chalk.cyan(config.api_url)}`);
      console.log(`  Token:    ${config.token ? chalk.green("configured") : chalk.red("not set")}`);
    });
}
