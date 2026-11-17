#!/usr/bin/env node
/**
 * Hindsight jcode `turn_end` / `session_end` hook.
 *
 * Install (${JCODE_HOME:-~/.jcode}/config.toml), as keys of the ONE `[hooks]` table:
 *   [hooks]
 *   turn_end = ['node "/abs/dist/jcode-stop-hook.js"']
 *   session_end = ['node "/abs/dist/jcode-stop-hook.js"']
 * Detached observers. Retains the session snapshot plus its journal; the event comes from stdin
 * when jcode pipes it, else from JCODE_HOOK_PAYLOAD (core/transcript-jcode.ts).
 */
import { runHarnessRetain } from "./harness/hook-lifecycle";

void runHarnessRetain("jcode");
