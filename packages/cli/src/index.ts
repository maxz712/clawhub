#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCloneCommands } from "./commands/clone.js";
import { registerChangeCommands } from "./commands/change.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerAttentionCommands } from "./commands/attention.js";
import { registerLogCommands } from "./commands/log.js";
import { registerStatusCommands } from "./commands/status.js";

const program = new Command();

program
  .name("clawforge")
  .description(
    chalk.bold("ClawForge CLI") +
      " -- AI-native code hosting where agents are first-class citizens",
  )
  .version("2.0.0");

registerAuthCommands(program);
registerCloneCommands(program);
registerChangeCommands(program);
registerReviewCommands(program);
registerAttentionCommands(program);
registerLogCommands(program);
registerStatusCommands(program);

program.parse();
