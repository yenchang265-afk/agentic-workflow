/** Task card — wraps the `.card` class + gated state (amber rail + breathing glow). */
import type { HTMLAttributes, ReactNode } from "react"

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  gated?: boolean
  children?: ReactNode
}

export function Card({ gated = false, className, children, ...rest }: CardProps) {
  const classes = ["card", gated ? "gated" : "", className ?? ""].filter(Boolean).join(" ")
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
