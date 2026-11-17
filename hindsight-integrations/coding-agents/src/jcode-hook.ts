#!/usr/bin/env node
/**
 * Hindsight jcode `user_prompt_submit` hook.
 *
 * Install (${JCODE_HOME:-~/.jcode}/config.toml), as a key of the ONE `[hooks]` table:
 *   [hooks]
 *   user_prompt_submit = ['node "/abs/dist/jcode-hook.js"']
 *   user_prompt_submit_timeout_ms = 30000
 * Synchronous: the JSON event arrives on stdin, and the reply's
 * `hookSpecificOutput.additionalContext` is appended to the conversation as a system reminder.
 */
import { runHarnessPrompt } from "./harness/hook-lifecycle";

void runHarnessPrompt("jcode");
