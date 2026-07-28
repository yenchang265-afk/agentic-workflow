/**
 * Per-stage aggregation label: stage names are shared across workflow kinds
 * (engineering's `build` vs a sitter's `build`), and every kind appends to one
 * flat `runs/`, so without the kind in the key they tally into one row.
 *
 * Newer runs record their kind (run-log footer `kind:` segment; sidecar
 * `RunEntry.kind`). Engineering — the default and the overwhelming majority —
 * keeps its bare stage names so historical rows (which recorded no kind and are
 * almost all engineering) don't split into a parallel "(kind unknown)"
 * population; only non-engineering kinds get the `kind/stage` prefix. Pure.
 */
export const stageLabel = (kind: string | undefined, stage: string): string =>
  kind && kind !== "engineering" ? `${kind}/${stage}` : stage
