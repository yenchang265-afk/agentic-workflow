/**
 * Secret redaction for durable, committed artifacts (task audit notes,
 * persisted plans, run logs). A stage that echoes a secret — a test's env
 * dump, a quoted config, a stack trace with a connection string — must not
 * leak it into files the loop commits to git. Applied at the write boundary
 * in `store.ts`. **Pure and total.**
 *
 * Shape-based scanning: recognized secret formats are replaced; custom-format
 * secrets (a company-internal token shaped like a UUID) pass through. Defense
 * in depth remains "keep secrets out of the working tree" — see
 * docs/design/threat-model.md T6.
 *
 * Posture: prefer false positives over leaks. A redacted non-secret costs a
 * little log fidelity; a leaked secret costs a rotation.
 */
export interface RedactionHit {
    readonly pattern: string;
    readonly count: number;
}
export interface Redacted {
    readonly text: string;
    readonly hits: readonly RedactionHit[];
}
/** Replace recognized secret shapes with `[REDACTED:<name>]`. Idempotent. */
export declare const redact: (text: string) => Redacted;
