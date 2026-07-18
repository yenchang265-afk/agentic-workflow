/**
 * Pure helpers for the stage form's asset pickers — kept out of the component
 * layer so they sit under the web test glob (src/web/creator/*.test.ts).
 */

export const knownNames = (items: readonly { name: string }[] | undefined): readonly string[] =>
  (items ?? []).map((i) => i.name)

/** True when the typed value is non-empty and absent from the inventory — show the checklist hint. */
export const isUnknownAsset = (names: readonly string[], value: string): boolean =>
  value.trim() !== "" && !names.includes(value.trim())
