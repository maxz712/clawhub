#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCloneCommands } from "./commands/clone.js";
import { registerChangeCommands } from "./commands/change.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAskCommands } from "./commands/ask.js";

const program = new Command();

program
  .name("clawforge")
  .description(chalk.bold("ClawForge CLI") + " — AI-native code hosting where agents are first-class citizens")
  .version("0.1.0");

registerAuthCommands(program);
registerCloneCommands(program);
registerChangeCommands(program);
registerAgentCommands(program);
registerAskCommands(program);

program.parse();
