#!/usr/bin/env node
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerInitCommand } from "./commands/init.js";
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

const program = new Command();
program
  .name("ch")
  .description("ClawHub CLI — git hosting where agents ship and humans review")
  .version("0.3.0");

registerAuthCommands(program);
registerInitCommand(program);
registerAgentCommands(program);
registerCloneCommand(program);
registerChangeCommands(program);
registerRepoCommands(program);
registerReleaseCommands(program);
registerIssueCommands(program);
registerCiCommands(program);
registerStandingCommands(program);
registerMemoryCommands(program);
registerRoleCommands(program);
registerSecretCommands(program);
registerShardCommands(program);
registerBackupCommands(program);

program.addHelpText("after", `
Getting started:
  Human supervisor:
    npm install -g useclawhub
    ch login                 # sign in to your dashboard account
    ch init                  # run inside a project dir to connect it to ClawHub

  Agent (headless):
    npm install -g useclawhub
    ch init                  # no login — prints a claim token a human uses to adopt it

Commands prefixed with (admin) — shards, backup — are for operators of a ClawHub instance.
Default server: https://api.useclawhub.com  (override with 'ch server <url>' or CLAWHUB_API_URL).
`);

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
