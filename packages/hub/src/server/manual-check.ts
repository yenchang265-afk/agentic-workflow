/**
 * Manual freshness — pure functions over injected file contents. The manual
 * (docs/manual.html) mentions `/agentic-loop:<kind> <verb>` commands; the
 * actual surface lives in each host's command frontmatter `argument-hint`.
 * Diffing the two catches the drift a hand-maintained manual accumulates:
 * verbs it shows that a host doesn't have, and verbs that exist undocumented.
 */

export interface CommandSurface {
  readonly kind: string
  readonly host: "opencode" | "claude"
  readonly verbs: readonly string[]
}

/** First token of each `|` segment of an argument-hint: `new <idea> | approve [id]` → [new, approve]. Pure. */
export const parseArgumentHint = (frontmatter: string): string[] => {
  const hint = /^argument-hint:\s*(.+)$/m.exec(frontmatter)?.[1]
  if (!hint) return []
  return hint
    .split("|")
    .map((seg) => seg.trim().split(/\s+/)[0] ?? "")
    .filter((v) => v && /^[a-z-]+$/.test(v))
}

export interface ManualMention {
  readonly kind: string
  readonly verb: string
}

/**
 * Every `/agentic-loop:<kind> <verb>` mention in the manual (verb optional).
 * A trailing word only counts as the verb when it belongs to the known verb
 * vocabulary — prose right after a bare mention ("… /agentic-loop:pr-sitter
 * too") must not read as a phantom verb. Pure.
 */
export const extractMentions = (html: string, knownVerbs: ReadonlySet<string>): ManualMention[] => {
  const out: ManualMention[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/\/agentic-loop:([a-z-]+)(?:\s+([a-z-]+))?/g)) {
    const kind = m[1] as string
    const candidate = m[2] ?? ""
    const verb = knownVerbs.has(candidate) ? candidate : ""
    const key = `${kind}:${verb}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, verb })
  }
  return out
}

/** Human-readable drift warnings. Pure. */
export const checkFreshness = (mentions: readonly ManualMention[], surfaces: readonly CommandSurface[]): string[] => {
  const warnings: string[] = []
  const kinds = new Set(surfaces.map((s) => s.kind))
  const hostsFor = (kind: string, verb: string): string[] =>
    surfaces.filter((s) => s.kind === kind && s.verbs.includes(verb)).map((s) => s.host)
  const allHosts = (kind: string): string[] => [...new Set(surfaces.filter((s) => s.kind === kind).map((s) => s.host))]

  for (const mention of mentions) {
    if (!kinds.has(mention.kind)) {
      warnings.push(`manual mentions /agentic-loop:${mention.kind} but no such loop kind ships`)
      continue
    }
    if (!mention.verb) continue
    const hosts = hostsFor(mention.kind, mention.verb)
    const expected = allHosts(mention.kind)
    if (hosts.length === 0) {
      warnings.push(`manual shows "/agentic-loop:${mention.kind} ${mention.verb}" but no host has that verb`)
    } else if (hosts.length < expected.length) {
      const missing = expected.filter((h) => !hosts.includes(h))
      warnings.push(
        `manual shows "/agentic-loop:${mention.kind} ${mention.verb}" but it only exists on ${hosts.join("+")} (not ${missing.join("+")})`,
      )
    }
  }

  const mentioned = new Set(mentions.map((m) => `${m.kind}:${m.verb}`))
  for (const surface of surfaces) {
    for (const verb of surface.verbs) {
      if (!mentioned.has(`${surface.kind}:${verb}`)) {
        mentioned.add(`${surface.kind}:${verb}`) // dedupe across hosts
        warnings.push(`verb "/agentic-loop:${surface.kind} ${verb}" exists but the manual never mentions it`)
      }
    }
  }
  return warnings
}
