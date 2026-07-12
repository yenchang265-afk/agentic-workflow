/**
 * Manual light/dark toggle. Stamps `data-theme` on <html> (which overrides the
 * prefers-color-scheme media query in theme.css) and persists the choice. The
 * pre-paint bootstrap in index.html applies the stored value before first
 * paint, so this only needs to reflect + flip it.
 */
import { useEffect, useState } from "react"
import { Button } from "./Button.js"
import { MoonIcon, SunIcon } from "./icons.js"

type Theme = "light" | "dark"

const STORAGE_KEY = "hub.theme"

const currentTheme = (): Theme => {
  const stamped = document.documentElement.dataset.theme
  if (stamped === "light" || stamped === "dark") return stamped
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // localStorage may be unavailable (private mode); the toggle still works in-session.
    }
  }, [theme])

  const next = theme === "dark" ? "light" : "dark"
  return (
    <Button
      variant="ghost"
      icon
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}
