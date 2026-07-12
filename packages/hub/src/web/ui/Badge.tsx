/** Small monospace status badge — wraps the `.badge` class + tone modifiers. */
import type { HTMLAttributes, ReactNode } from "react"

type Tone = "neutral" | "gate" | "ok"

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  children?: ReactNode
}

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: "",
  gate: "gate",
  ok: "ok",
}

export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  const classes = ["badge", TONE_CLASS[tone], className ?? ""].filter(Boolean).join(" ")
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  )
}
