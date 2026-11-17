#!/usr/bin/env node
/**
 * Hindsight jcode `session_start` hook.
 *
 * Install (${JCODE_HOME:-~/.jcode}/config.toml), as a key of the ONE `[hooks]` table:
 *   [hooks]
 *   session_start = ['node "/abs/dist/jcode-sessionstart-hook.js"']
 * A detached observer whose output jcode discards, so it runs for its side effects (seed, daemon
 * warm-up, skill sync) and stashes its context for the session's next prompt hook. The event comes
 * from stdin when jcode pipes it, else from JCODE_HOOK_PAYLOAD (core/transcript-jcode.ts).
 */
import { runHarnessSessionStart } from "./harness/hook-lifecycle";

void runHarnessSessionStart("jcode");
