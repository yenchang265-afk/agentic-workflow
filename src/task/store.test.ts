import assert from "node:assert/strict"
import { test } from "node:test"
import type { Task } from "./schema.ts"
import { selectNext } from "./store.ts"

const task = (id: string, priority: number): Task => ({
  id,
  title: id,
  priority,
  acceptance: [],
  body: "",
  path: `/r/docs/tasks/approved/${id}.md`,
})

test("selectNext returns null for an empty backlog", () => {
  assert.equal(selectNext([]), null)
})

test("selectNext picks the lowest priority number first", () => {
  const picked = selectNext([task("b", 5), task("a", 2), task("c", 9)])
  assert.equal(picked?.id, "a")
})

test("selectNext breaks priority ties by id", () => {
  const picked = selectNext([task("zebra", 1), task("apple", 1)])
  assert.equal(picked?.id, "apple")
})

test("selectNext does not mutate the input array", () => {
  const tasks = [task("b", 5), task("a", 2)]
  selectNext(tasks)
  assert.equal(tasks[0]?.id, "b")
})
