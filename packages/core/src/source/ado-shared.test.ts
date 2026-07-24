import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * The pure ADO response normalizers shared by the `ado-pr.ts` / `ado-ci-runs.ts`
 * work sources and the ship gate — all of which reach ADO through the `az` CLI,
 * whose `az devops invoke` returns the same JSON envelopes these schemas parse.
 */

test("AdoPrFieldsSchema reads reviewer identity and requirement additively", async () => {
  const { AdoPrFieldsSchema } = await import("./ado-shared.js")
  const pr = AdoPrFieldsSchema.parse({
    pullRequestId: 7,
    title: "t",
    sourceRefName: "refs/heads/feat/x",
    targetRefName: "refs/heads/main",
    reviewers: [{ uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true }, { vote: -5 }],
  })
  assert.deepEqual(pr.reviewers?.[0], { uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true })
  // Legacy entries without identity still parse (defaults, not rejections).
  assert.deepEqual(pr.reviewers?.[1], { uniqueName: "", vote: -5, isRequired: false })
})

test("normalizeAdoBuild maps ADO's build shape into the shared CiRun fields", async () => {
  const { normalizeAdoBuild, AdoBuildSchema } = await import("./ado-shared.js")
  const succeeded = AdoBuildSchema.parse({
    sourceVersion: "abc123",
    status: "completed",
    result: "succeeded",
    definition: { name: "CI" },
    queueTime: "2026-07-05T00:00:00Z",
  })
  assert.deepEqual(normalizeAdoBuild(succeeded), {
    headSha: "abc123",
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    createdAt: "2026-07-05T00:00:00Z",
  })
  const failed = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "failed" })
  assert.equal(normalizeAdoBuild(failed).conclusion, "failure")
  // A partial success still means something broke — judged as failing.
  const partial = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "partiallySucceeded" })
  assert.equal(normalizeAdoBuild(partial).conclusion, "failure")
  // A manual cancel isn't a code breakage — neither failing nor a green signal.
  const canceled = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "canceled" })
  assert.equal(normalizeAdoBuild(canceled).conclusion, null)
  // In-flight builds carry no result yet.
  const pending = AdoBuildSchema.parse({ sourceVersion: "x", status: "inProgress" })
  assert.equal(normalizeAdoBuild(pending).conclusion, null)
  assert.equal(normalizeAdoBuild(pending).status, "inProgress")
})

test("normalizeAdoBuild falls back through queueTime → startTime → finishTime for createdAt", async () => {
  const { normalizeAdoBuild, AdoBuildSchema } = await import("./ado-shared.js")
  const noQueueTime = AdoBuildSchema.parse({ sourceVersion: "x", startTime: "2026-07-05T01:00:00Z", finishTime: "2026-07-05T02:00:00Z" })
  assert.equal(normalizeAdoBuild(noQueueTime).createdAt, "2026-07-05T01:00:00Z")
  const onlyFinish = AdoBuildSchema.parse({ sourceVersion: "x", finishTime: "2026-07-05T02:00:00Z" })
  assert.equal(normalizeAdoBuild(onlyFinish).createdAt, "2026-07-05T02:00:00Z")
})
