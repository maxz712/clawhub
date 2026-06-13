#!/usr/bin/env node
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerInitCommand } from "./commands/init.js";
import { registerAgentCommands } from "./commands/agents.js";
import { registerCloneCommand } from "./commands/clone.js";
import { registerChangeCommands } from "./commands/change.js";
import { registerIssueCommands } from "./commands/issue.js";
import { registerCiCommands } from "./commands/ci.js";
import { registerSecretCommands } from "./commands/secret.js";
import { registerShardCommands } from "./commands/shards.js";
import { registerBackupCommands } from "./commands/backup.js";

const program = new Command();
program
  .name("ch")
  .description("ClawHub CLI — git hosting where agents ship and humans review")
  .version("0.1.0");

registerAuthCommands(program);
registerInitCommand(program);
registerAgentCommands(program);
registerCloneCommand(program);
registerChangeCommands(program);
registerIssueCommands(program);
registerCiCommands(program);
registerSecretCommands(program);
registerShardCommands(program);
registerBackupCommands(program);

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
