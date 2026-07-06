import type { LoadedManifest } from "../manifest/schema.js";
import { type TemplateContext } from "../manifest/template.js";
import type { Action, Config, LoopState } from "./state.js";
import type { Verdict } from "./verdict.js";
/**
 * The template context a stage prompt renders against. Everything derivable
 * from the state is precomputed here (diff command, worktree pinning
 * paragraph) so ordinary loop kinds need no compose hooks.
 */
export declare const promptContext: (state: LoopState) => TemplateContext;
/** Render the prompt threaded into `target`'s stage command. */
export declare const composePrompt: (loaded: LoadedManifest, state: LoopState, target: string) => string;
/** The first step to drive for a freshly-constructed state — fires its own stage. */
export declare const firstStep: (loaded: LoadedManifest, state: LoopState) => {
    state: LoopState;
    action: Action;
};
/**
 * Decide what to do when `state.stage` completed. `output` is that stage's
 * captured text (stored as its artifact). `verdict` is a check stage's
 * resolved verdict — recorded via the `loop_verdict` tool, never parsed out
 * of `output` (free text is an untrusted channel; see verdict.ts). A missing
 * verdict on a check stage is a FAIL, not a stall.
 */
export declare const advance: (loaded: LoadedManifest, state: LoopState, config: Config, output: string, verdict?: Verdict | null) => {
    state: LoopState;
    action: Action;
};
