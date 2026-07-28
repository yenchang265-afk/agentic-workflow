import assert from "node:assert/strict"
import { test } from "node:test"
import { buildHash, DEFAULT_SCREEN, parseHash, withQuery } from "./route.js"

test("parseHash reads screen, params and query", () => {
  assert.deepEqual(parseHash("#/monitor/engineering"), {
    screen: "monitor",
    params: ["engineering"],
    query: {},
  })
  assert.deepEqual(parseHash("#/monitor?task=plan-review%2Ffix-pagination&repo=web"), {
    screen: "monitor",
    params: [],
    query: { task: "plan-review/fix-pagination", repo: "web" },
  })
  assert.deepEqual(parseHash("#/config"), { screen: "config", params: [], query: {} })
})

test("parseHash is total — anything unrecognized lands on the default screen", () => {
  for (const hash of ["", "#", "#/", "#/nope", "#/nope/deeper", "monitor"]) {
    assert.equal(parseHash(hash).screen, hash === "monitor" ? "monitor" : DEFAULT_SCREEN, `hash: ${hash}`)
  }
  // A bad route drops its params rather than handing them to the wrong screen.
  assert.deepEqual(parseHash("#/nope/engineering").params, [])
})

test("parseHash survives a malformed percent escape rather than throwing", () => {
  assert.deepEqual(parseHash("#/monitor/100%"), { screen: "monitor", params: ["100%"], query: {} })
})

test("buildHash round-trips through parseHash", () => {
  for (const hash of [
    "#/monitor",
    "#/monitor/engineering",
    "#/creator/pr-sitter",
    "#/monitor?repo=web-app",
    "#/monitor/engineering?run=fix-pagination-bug&repo=web-app",
  ]) {
    const route = parseHash(hash)
    assert.equal(buildHash(route), hash, `round-trip: ${hash}`)
    assert.deepEqual(parseHash(buildHash(route)), route)
  }
})

test("buildHash encodes segments and drops empty or undefined query values", () => {
  assert.equal(buildHash({ screen: "monitor", params: ["a/b"] }), "#/monitor/a%2Fb")
  assert.equal(buildHash({ screen: "monitor", query: { run: undefined, task: "" } }), "#/monitor")
  assert.equal(buildHash({ screen: "monitor", query: { repo: "a b" } }), "#/monitor?repo=a%20b")
})

test("withQuery merges over the current query and drops keys set to undefined", () => {
  const route = parseHash("#/monitor/engineering?repo=web&run=r1")
  assert.equal(withQuery(route, { run: "r2" }), "#/monitor/engineering?repo=web&run=r2")
  // Closing the drawer must not also lose the repo you are looking at.
  assert.equal(withQuery(route, { run: undefined }), "#/monitor/engineering?repo=web")
  assert.equal(withQuery(route, { task: "draft/new-idea" }), "#/monitor/engineering?repo=web&run=r1&task=draft%2Fnew-idea")
})
