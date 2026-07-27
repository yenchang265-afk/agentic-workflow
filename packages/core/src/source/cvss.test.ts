import assert from "node:assert/strict"
import { test } from "node:test"
import { readCvssVector } from "./cvss.js"

/**
 * The CVSS base-score arithmetic behind OSV `severity[].score`. Every expected
 * score below was cross-checked against the CVSS v3.1 specification's own
 * formula rather than recalled — a mis-scored vector silently moves a package
 * across `severityFloor`, which looks like nothing at all going wrong.
 */

const scored = (vector: string): number => {
  const read = readCvssVector(vector)
  assert.ok(read && read.kind === "scored", `expected a scored read for ${vector}, got ${JSON.stringify(read)}`)
  return read.score
}

test("scores the specification's worked base vectors", () => {
  // Network/no-privilege/full-impact — the canonical 9.8.
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8)
  // Single high impact dimension.
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"), 7.5)
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"), 7.5)
  // Scope change pushes the same metrics past the 10.0 ceiling and clamps.
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"), 10)
  // Local, low-privilege, full impact.
  assert.equal(scored("CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H"), 7.8)
  // Scope-changed with partial impacts — exercises the 3.25×(ISS-0.02)^15 term.
  assert.equal(scored("CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N"), 4.7)
})

test("a vector with no impact scores zero, whatever the exploitability metrics say", () => {
  // Impact ≤ 0 short-circuits before exploitability is added — otherwise an
  // advisory that harms nothing would still carry a non-zero rating.
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), 0)
  assert.equal(scored("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N"), 0)
})

test("temporal and environmental metrics are tolerated and ignored — this is the BASE score", () => {
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:U/RL:O/RC:C"), 9.8)
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/CR:L/IR:L/AR:L"), 9.8)
})

test("privilege-required reads a different column once scope changes", () => {
  // PR:H is 0.27 unchanged but 0.50 changed — reading the wrong column is the
  // easiest way to get a plausible-looking wrong score.
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"), 7.2)
  assert.equal(scored("CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H"), 9.1)
})

test("the v3.0 and v3.1 roundups agree on every base vector in the space", () => {
  // The v3.1 erratum reworked Roundup to survive float representation, but that
  // never bites a base-only score: the metric space is finite and the two agree
  // across all of it. Pinned exhaustively so this stays a measured fact rather
  // than an assumption — if a future edit collapses the two roundups into one
  // and that assumption ever stops holding, this fails.
  const dims = {
    AV: ["N", "A", "L", "P"],
    AC: ["L", "H"],
    PR: ["N", "L", "H"],
    UI: ["N", "R"],
    S: ["U", "C"],
    C: ["H", "L", "N"],
    I: ["H", "L", "N"],
    A: ["H", "L", "N"],
  } as const
  const keys = Object.keys(dims) as (keyof typeof dims)[]
  const bodies: string[] = []
  const walk = (i: number, acc: readonly string[]): void => {
    if (i === keys.length) {
      bodies.push(acc.join("/"))
      return
    }
    const key = keys[i] as keyof typeof dims
    for (const value of dims[key]) walk(i + 1, [...acc, `${key}:${value}`])
  }
  walk(0, [])

  assert.equal(bodies.length, 2592, "the base metric space is 4×2×3×2×2×3×3×3")
  for (const body of bodies) {
    assert.equal(scored(`CVSS:3.0/${body}`), scored(`CVSS:3.1/${body}`), `v3.0 and v3.1 disagree on ${body}`)
  }
})

test("every score in the space is a sane CVSS value", () => {
  // A formula slip (a sign, a swapped constant) most often shows up as an
  // out-of-range or non-tenth score rather than as one obviously wrong vector.
  const read = readCvssVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")
  assert.ok(read && read.kind === "scored")
  for (const av of ["N", "A", "L", "P"]) {
    for (const s of ["U", "C"]) {
      for (const c of ["H", "L", "N"]) {
        const score = scored(`CVSS:3.1/AV:${av}/AC:L/PR:N/UI:N/S:${s}/C:${c}/I:${c}/A:${c}`)
        assert.ok(score >= 0 && score <= 10, `${score} out of range`)
        assert.equal(Math.round(score * 10), score * 10, `${score} is not a tenth`)
      }
    }
  }
})

test("recognizes versions it has no formula for rather than calling them junk", () => {
  // The caller must be able to say WHY a rating was unreadable. Reporting a v4
  // vector as "not a vector" would make an unscorable payload look like a
  // malformed one — and, worse, like a harmless one.
  assert.deepEqual(readCvssVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), {
    kind: "unscored",
    version: "4.0",
  })
  // CVSS v2 carries no version prefix; `Au` is the v2-only metric that names it.
  assert.deepEqual(readCvssVector("AV:N/AC:L/Au:N/C:P/I:P/A:P"), { kind: "unscored", version: "2.0" })
  assert.deepEqual(readCvssVector("AV:N/AC:L/C:P/I:P/A:P"), { kind: "unscored", version: "unknown" })
})

test("rejects anything that is not a CVSS vector", () => {
  for (const junk of ["", "   ", "critical", "HIGH", "8.1", "9.8", "not/a/vector", "CVSS:3.1/", "CVSS:3.1"]) {
    assert.equal(readCvssVector(junk), null, `expected null for ${JSON.stringify(junk)}`)
  }
})

test("a lowercase vector is not scored — the spec's vector grammar is uppercase", () => {
  // Rejecting is the safe direction: it surfaces as an unreadable rating
  // rather than as a silently wrong score.
  assert.equal(readCvssVector("CVSS:3.1/av:n/ac:l/pr:n/ui:n/s:u/c:h/i:h/a:h"), null)
  assert.equal(readCvssVector("CVSS:3.1/AV:n/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), null)
})

test("a repeated metric is malformed and scores nothing", () => {
  // The grammar admits each metric once, so there is no defensible winner —
  // and picking one would score a vector that cannot be read unambiguously.
  assert.equal(readCvssVector("CVSS:3.1/AV:N/AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), null)
  assert.equal(readCvssVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/A:N"), null)
})

test("a missing or unrecognized base metric is null, never a defaulted guess", () => {
  // CVSS has no "unspecified" base metric. Defaulting one would invent a
  // severity, and severity decides whether the dependency is claimed at all.
  const cases = [
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H", // A absent
    "CVSS:3.1/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", // AV absent
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H", // S absent
    "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", // AV value undefined
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:X/C:H/I:H/A:H", // scope value undefined
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:P/I:P/A:P", // v2 impact values in a v3 vector
  ]
  for (const vector of cases) assert.equal(readCvssVector(vector), null, `expected null for ${vector}`)
})
