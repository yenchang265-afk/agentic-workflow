/**
 * Column alignment for a run summary's stage table.
 *
 * The `extra` columns are whatever trailing fields a stage wrote into the run
 * log, so they are a property of each ROW, not of the table. Taking the headers
 * from row 0 and then rendering `Object.values(row)` for every other row lines
 * cells up by POSITION: a row whose keys differ from row 0's paints its values
 * under someone else's headers, and a wrong number reads exactly like a right
 * one. Both sides go through the header key instead.
 *
 * Pure, and here rather than inline in the component, because this package has
 * no DOM test harness — anything with a decidable right answer has to live
 * where `node --test` can reach it.
 */

/** A row's per-stage trailing columns, as the run-log parser produced them. */
interface HasExtra {
  readonly extra: Readonly<Record<string, string>>
}

/**
 * Every `extra` key any row carries, in first-seen order.
 *
 * The union, not row 0's keys: a column only some rows wrote is still a real
 * column, and dropping it hides data rather than misplacing it.
 */
export const extraHeaders = (rows: readonly HasExtra[]): string[] => {
  const seen: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row.extra)) if (!seen.includes(key)) seen.push(key)
  }
  return seen
}

/**
 * One row's cells under `headers`. A key this row doesn't carry renders as the
 * em dash the rest of the UI uses for "not recorded" — never as a neighbouring
 * column's value, and never as an empty cell that reads like a zero.
 */
export const alignRow = (headers: readonly string[], extra: Readonly<Record<string, string>>): string[] =>
  headers.map((header) => extra[header] ?? "—")
