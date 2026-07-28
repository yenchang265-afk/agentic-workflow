/**
 * CVSS base-score arithmetic for the dep-sitter's OSV path.
 *
 * In the OSV schema a vulnerability's severity is `severity: [{type, score}]`
 * where `score` holds a CVSS **vector string**, not a label and not a number.
 * That is the spec's primary severity channel, so a scanner emitting only
 * spec-shaped severity has nothing readable without this module.
 *
 * Scope is deliberately **v3.0 and v3.1 base scores only**:
 *
 * - **v4.0** needs the ~270-entry MacroVector lookup table plus its
 *   interpolation. Hand-rolling that slab is disproportionate here, and a
 *   single wrong entry silently mis-bands a real advisory — which moves
 *   packages across `severityFloor` without anything looking wrong.
 * - **v2** uses a different formula and a different metric set (`Au`, and
 *   partial/complete impact values). Largely historical.
 *
 * Both are still *recognized* and reported as `unscored` rather than as "not a
 * vector", so the caller can say why a rating was unreadable instead of
 * silently treating the record as harmless.
 *
 * Pure — no shell, no fs, no clock.
 */

/**
 * What a `severity[].score` string turned out to be.
 * `null` means it is not a CVSS vector at all (a label, a bare number, junk).
 */
export type CvssRead =
  | { readonly kind: "scored"; readonly version: "3.0" | "3.1"; readonly score: number }
  /** A CVSS vector whose version this module has no formula for. */
  | { readonly kind: "unscored"; readonly version: string }
  | null

/**
 * Base metric values from the CVSS v3.1 specification (identical in v3.0).
 * `PR` is scope-dependent — an unchanged scope and a changed scope read
 * different columns for the same metric value.
 */
const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as const
const AC = { L: 0.77, H: 0.44 } as const
const PR_UNCHANGED = { N: 0.85, L: 0.62, H: 0.27 } as const
const PR_CHANGED = { N: 0.85, L: 0.68, H: 0.5 } as const
const UI = { N: 0.85, R: 0.62 } as const
const CIA = { H: 0.56, L: 0.22, N: 0 } as const

/**
 * v3.1's Roundup. The naive `ceil(x * 10) / 10` of v3.0 is float-fragile: a
 * value that is mathematically an exact tenth can be stored as
 * 4.000000000000001 and round to 4.1. v3.1 fixed that by doing the comparison
 * in integer space, so a value within 1e-5 of a tenth lands *on* it.
 *
 * That erratum does NOT reach a base score: the base metric space is finite
 * (2592 vectors) and the two roundups agree on every one of them — pinned
 * exhaustively by cvss.test.ts, because the equivalence is surprising enough
 * that someone would otherwise "simplify" these into one and be right by
 * accident. The divergence needs temporal/environmental values, which this
 * module does not compute. Both are kept anyway so a v3.0 vector is scored by
 * v3.0's own rule rather than by an assumption that happens to hold.
 */
const roundUp31 = (x: number): number => {
  const i = Math.round(x * 100_000)
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10
}

/** v3.0's Roundup — kept verbatim so a v3.0 vector scores the way v3.0 said it did. */
const roundUp30 = (x: number): number => Math.ceil(x * 10) / 10

/** Split a vector body into its `KEY:VALUE` pairs; null when any token is malformed. */
const metricsOf = (body: string): Record<string, string> | null => {
  const out: Record<string, string> = {}
  for (const token of body.split("/")) {
    if (!token) return null
    const at = token.indexOf(":")
    if (at <= 0 || at === token.length - 1) return null
    const key = token.slice(0, at)
    const value = token.slice(at + 1)
    if (!/^[A-Za-z]+$/.test(key) || !/^[A-Za-z]+$/.test(value)) return null
    // A repeated metric is malformed: the spec's vector grammar admits each
    // metric at most once, so there is no defensible way to pick a winner.
    // Rejecting matches how a missing metric is handled — never score a vector
    // this module cannot read unambiguously.
    if (key in out) return null
    out[key] = value
  }
  return out
}

/**
 * Base score of a parsed v3 metric set; null when a required metric is absent
 * or carries a value the spec does not define.
 *
 * A missing metric is NEVER defaulted. CVSS has no "unspecified" base metric,
 * so a guess here would invent a severity — and severity drives whether the
 * dep-sitter claims the package at all.
 */
const baseScore30x = (m: Readonly<Record<string, string>>, roundUp: (x: number) => number): number | null => {
  const scope = m["S"]
  if (scope !== "U" && scope !== "C") return null
  const changed = scope === "C"

  const av = AV[m["AV"] as keyof typeof AV]
  const ac = AC[m["AC"] as keyof typeof AC]
  const pr = (changed ? PR_CHANGED : PR_UNCHANGED)[m["PR"] as keyof typeof PR_UNCHANGED]
  const ui = UI[m["UI"] as keyof typeof UI]
  const c = CIA[m["C"] as keyof typeof CIA]
  const i = CIA[m["I"] as keyof typeof CIA]
  const a = CIA[m["A"] as keyof typeof CIA]
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null

  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss
  if (impact <= 0) return 0
  const exploitability = 8.22 * av * ac * pr * ui
  const raw = changed ? 1.08 * (impact + exploitability) : impact + exploitability
  return roundUp(Math.min(raw, 10))
}

/** A prefixless run of `KEY:VALUE` pairs — the shape of a CVSS v2 vector. */
const looksLikeVector = (s: string): boolean => /^[A-Za-z]+:[A-Za-z]+(\/[A-Za-z]+:[A-Za-z]+)*$/.test(s)

/**
 * Read an OSV `severity[].score` string.
 *
 * Temporal and environmental metrics (`E`, `RL`, `RC`, `CR`, …) are tolerated
 * and ignored: this computes the BASE score, and a vector carrying them is
 * still a valid vector.
 */
export const readCvssVector = (score: string): CvssRead => {
  const trimmed = score.trim()
  if (!trimmed) return null

  const versioned = /^CVSS:(\d+\.\d+)\/(.+)$/.exec(trimmed)
  if (versioned) {
    const version = versioned[1] as string
    if (version !== "3.0" && version !== "3.1") return { kind: "unscored", version }
    const metrics = metricsOf(versioned[2] as string)
    if (!metrics) return null
    const value = baseScore30x(metrics, version === "3.1" ? roundUp31 : roundUp30)
    return value === null ? null : { kind: "scored", version, score: value }
  }

  // CVSS v2 vectors carry no version prefix (`AV:N/AC:L/Au:N/C:P/I:P/A:P`).
  // `Au` is v2-only, so it is the reliable marker; without it a prefixless
  // metric run is some other vector this module cannot name a version for.
  if (looksLikeVector(trimmed)) {
    return { kind: "unscored", version: /(^|\/)Au:/.test(trimmed) ? "2.0" : "unknown" }
  }
  return null
}
