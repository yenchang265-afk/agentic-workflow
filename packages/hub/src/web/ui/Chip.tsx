/** Pill "instrument readout" — wraps the `.chip` class + gate tone. */
import type { HTMLAttributes, ReactNode } from "react"

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  gate?: boolean
  children?: ReactNode
}

export function Chip({ gate = false, className, children, ...rest }: ChipProps) {
  const classes = ["chip", gate ? "gate" : "", className ?? ""].filter(Boolean).join(" ")
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  )
}
