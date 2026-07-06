import { z } from "zod";
/**
 * The declarative definition of one loop kind: its stages, transition table,
 * work-source binding, and gate semantics. A loop kind lives in
 * `loops/<kind>/loop.json` next to per-stage prompt templates
 * (`loops/<kind>/stages/*.md`); the engine (`loop/engine.ts`) interprets it.
 * Logic a manifest can't express hangs off named hooks resolved through
 * `registry.ts` (the TS escape hatch).
 */
/** What a stage transition does once the engine picks it. */
export declare const EffectSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"fire">;
    stage: z.ZodString;
    dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
    countIteration: z.ZodDefault<z.ZodBoolean>;
    capMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"park">;
    toStatus: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"done">;
    toStatus: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"stop">;
    message: z.ZodString;
}, z.core.$strip>], "kind">;
export type Effect = z.infer<typeof EffectSchema>;
export declare const StageDefSchema: z.ZodObject<{
    name: z.ZodString;
    kind: z.ZodEnum<{
        check: "check";
        work: "work";
    }>;
    command: z.ZodString;
    agent: z.ZodString;
    prompt: z.ZodString;
    isolation: z.ZodDefault<z.ZodEnum<{
        worktree: "worktree";
        none: "none";
    }>>;
    timeoutMinutes: z.ZodOptional<z.ZodNumber>;
    bashAllowlist: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type StageDef = z.infer<typeof StageDefSchema>;
declare const TransitionSchema: z.ZodObject<{
    onDone: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fire">;
        stage: z.ZodString;
        dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        countIteration: z.ZodDefault<z.ZodBoolean>;
        capMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"park">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"done">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"stop">;
        message: z.ZodString;
    }, z.core.$strip>], "kind">>;
    onPass: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fire">;
        stage: z.ZodString;
        dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        countIteration: z.ZodDefault<z.ZodBoolean>;
        capMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"park">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"done">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"stop">;
        message: z.ZodString;
    }, z.core.$strip>], "kind">>;
    onFail: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fire">;
        stage: z.ZodString;
        dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        countIteration: z.ZodDefault<z.ZodBoolean>;
        capMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"park">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"done">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"stop">;
        message: z.ZodString;
    }, z.core.$strip>], "kind">>;
    onError: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fire">;
        stage: z.ZodString;
        dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        countIteration: z.ZodDefault<z.ZodBoolean>;
        capMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"park">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"done">;
        toStatus: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"stop">;
        message: z.ZodString;
    }, z.core.$strip>], "kind">>;
}, z.core.$strip>;
export type Transition = z.infer<typeof TransitionSchema>;
export declare const WorkSourceBindingSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"backlog">;
    statuses: z.ZodArray<z.ZodString>;
    pools: z.ZodArray<z.ZodObject<{
        status: z.ZodString;
        entryStage: z.ZodString;
        claimPredicate: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"github-pr">;
    query: z.ZodString;
    triggers: z.ZodArray<z.ZodEnum<{
        "failing-checks": "failing-checks";
        "changes-requested": "changes-requested";
        "new-comments": "new-comments";
        "merge-conflict": "merge-conflict";
    }>>;
}, z.core.$strip>], "type">;
export type WorkSourceBinding = z.infer<typeof WorkSourceBindingSchema>;
export declare const LoopManifestSchema: z.ZodObject<{
    kind: z.ZodString;
    version: z.ZodLiteral<1>;
    description: z.ZodString;
    workSource: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"backlog">;
        statuses: z.ZodArray<z.ZodString>;
        pools: z.ZodArray<z.ZodObject<{
            status: z.ZodString;
            entryStage: z.ZodString;
            claimPredicate: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"github-pr">;
        query: z.ZodString;
        triggers: z.ZodArray<z.ZodEnum<{
            "failing-checks": "failing-checks";
            "changes-requested": "changes-requested";
            "new-comments": "new-comments";
            "merge-conflict": "merge-conflict";
        }>>;
    }, z.core.$strip>], "type">;
    stages: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        kind: z.ZodEnum<{
            check: "check";
            work: "work";
        }>;
        command: z.ZodString;
        agent: z.ZodString;
        prompt: z.ZodString;
        isolation: z.ZodDefault<z.ZodEnum<{
            worktree: "worktree";
            none: "none";
        }>>;
        timeoutMinutes: z.ZodOptional<z.ZodNumber>;
        bashAllowlist: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    transitions: z.ZodRecord<z.ZodString, z.ZodObject<{
        onDone: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"fire">;
            stage: z.ZodString;
            dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
            countIteration: z.ZodDefault<z.ZodBoolean>;
            capMessage: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"park">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"done">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"stop">;
            message: z.ZodString;
        }, z.core.$strip>], "kind">>;
        onPass: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"fire">;
            stage: z.ZodString;
            dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
            countIteration: z.ZodDefault<z.ZodBoolean>;
            capMessage: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"park">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"done">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"stop">;
            message: z.ZodString;
        }, z.core.$strip>], "kind">>;
        onFail: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"fire">;
            stage: z.ZodString;
            dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
            countIteration: z.ZodDefault<z.ZodBoolean>;
            capMessage: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"park">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"done">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"stop">;
            message: z.ZodString;
        }, z.core.$strip>], "kind">>;
        onError: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"fire">;
            stage: z.ZodString;
            dropArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
            countIteration: z.ZodDefault<z.ZodBoolean>;
            capMessage: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"park">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"done">;
            toStatus: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"stop">;
            message: z.ZodString;
        }, z.core.$strip>], "kind">>;
    }, z.core.$strip>>;
    maxIterations: z.ZodOptional<z.ZodNumber>;
    hooks: z.ZodDefault<z.ZodObject<{
        compose: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        validateBeforeTransition: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type LoopManifest = z.infer<typeof LoopManifestSchema>;
/** The manifest plus its loaded per-stage prompt templates, keyed by stage name. */
export interface LoadedManifest {
    readonly manifest: LoopManifest;
    readonly prompts: Readonly<Record<string, string>>;
}
/** Find a stage definition by name; throws on an unknown stage (a manifest/state mismatch). */
export declare const stageDef: (manifest: LoopManifest, name: string) => StageDef;
/** Validate a raw manifest object; throws a readable error on schema failure. */
export declare const parseManifest: (raw: unknown) => LoopManifest;
export {};
