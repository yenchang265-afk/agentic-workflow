/**
 * The single button primitive. Wraps the `.btn` class system so the ~5 former
 * ad-hoc button looks collapse into one place. Behaviour is a plain <button>.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "default" | "primary" | "danger" | "ghost"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  icon?: boolean
  children?: ReactNode
}

const VARIANT_CLASS: Readonly<Record<Variant, string>> = {
  default: "",
  primary: "btn--primary",
  danger: "btn--danger",
  ghost: "btn--ghost",
}

export function Button({ variant = "default", icon = false, className, children, ...rest }: ButtonProps) {
  const classes = ["btn", VARIANT_CLASS[variant], icon ? "btn--icon" : "", className ?? ""]
    .filter(Boolean)
    .join(" ")
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  )
}
