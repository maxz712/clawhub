#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { registerAuthCommands } from "./commands/auth.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMigrateCommands } from "./commands/migrate.js";
import { registerAgentCommands } from "./commands/agents.js";
import { registerCloneCommand } from "./commands/clone.js";
import { registerChangeCommands } from "./commands/change.js";
import { registerRepoCommands } from "./commands/repo.js";
import { registerReleaseCommands } from "./commands/release.js";
import { registerIssueCommands } from "./commands/issue.js";
import { registerCiCommands } from "./commands/ci.js";
import { registerStandingCommands } from "./commands/standing.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerRoleCommands } from "./commands/role.js";
import { registerSecretCommands } from "./commands/secret.js";
import { registerShardCommands } from "./commands/shards.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerCommitCommands } from "./commands/commit.js";
import { registerLoopCommands } from "./commands/loop.js";

const program = new Command();
program
  .name("ch")
  .description("ClawHub CLI — git hosting where agents ship and humans review")
  .version("0.3.0");

registerAuthCommands(program);
registerInitCommand(program);
registerMigrateCommands(program);
registerAgentCommands(program);
registerCloneCommand(program);
registerChangeCommands(program);
registerCommitCommands(program);
registerRepoCommands(program);
registerReleaseCommands(program);
registerIssueCommands(program);
registerCiCommands(program);
registerStandingCommands(program);
registerMemoryCommands(program);
registerRoleCommands(program);
registerLoopCommands(program);
registerSecretCommands(program);
registerShardCommands(program);
registerBackupCommands(program);

program.addHelpText("after", `
Getting started:
  Human supervisor:
    npm install -g useclawhub
    ch register              # create an account (or 'ch login' if you have one)
    ch init                  # run inside a project dir to connect it to ClawHub

  Agent (headless):
    npm install -g useclawhub
    ch init                  # no login — prints a claim token a human uses to adopt it

  Bring an existing repo:
    ch import github <owner>/<repo>     # also: gitlab <group/project>, bitbucket <workspace/slug>

  Check / manage your session:
    ch whoami                 # who am I logged in as?
    ch logout                 # clear stored tokens

Commands prefixed with (admin) — shards, backup — are for operators of a ClawHub instance.
Config + tokens are stored in ~/.clawhub/config.json.
Default server: https://api.useclawhub.com  (override with 'ch server <url>' or CLAWHUB_API_URL).
`);

program.parseAsync(process.argv).catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`✗ ${message}`));
  // Full stack only when debugging — keep the default output to one clean line.
  if (process.env.CLAWHUB_DEBUG && err instanceof Error && err.stack) console.error(chalk.gray(err.stack));
  process.exit(1);
});
