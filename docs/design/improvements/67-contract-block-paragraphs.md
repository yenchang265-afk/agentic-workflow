English | [繁體中文](67-contract-block-paragraphs.zh-TW.md)

# 67 — Contract blocks read as paragraphs

**Status: implemented.**

## The problem

Every prompt contract block (`verdictContractBlock`, `workScopeBlock`,
`planContractBlock`, `planVisualizationBlock`, `checkDiscoveryBlock`,
`noMachineChecksBlock`, `dependencyContractBlock`, `passFocusBlock`) was
authored one clause per array element and joined with a single space. A
VERIFY prompt's tail therefore rendered as one ~900-word paragraph in which
`PLAN DEFECT:`, `ACCEPTANCE CRITERIA:` and `PROOF OF WORK:` — three distinct
sub-contracts — ran mid-sentence into each other. The blocks were separated
from each other by a blank line; the defect was inside each block.

## What changed

- **`joinClauses`** in `verdict.ts`: a clause that opens with an ALL-CAPS
  label starts a new paragraph; every other clause keeps the space join.
  Applied at all eight sites. No wording changes.
- The engine's `\n\n` glue between blocks is untouched, and
  `engine.test.ts`'s oracle imports the real builders, so composition parity
  holds without an oracle edit.

## Sharp edges

- **Label, not line break.** Breaking at every array element would turn
  clauses that are half-sentences into ragged lines; the label regex is what
  distinguishes a sub-contract from a continuation.
