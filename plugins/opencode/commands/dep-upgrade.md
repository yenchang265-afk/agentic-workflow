---
description: Enter the UPGRADE stage of the dep-sitter loop — apply the ordered dependency bump and fix its fallout
agent: workflow-dep-upgrade
subtask: true
---

Run the **UPGRADE** stage of the dep-sitter loop
(scan → upgrade → verify → publish) on:

**$ARGUMENTS**

Delegated to the `workflow-dep-upgrade` subagent, which bumps exactly the ordered
package (manifest + lockfile), fixes the fallout, and commits locally. It
never pushes (publish's job) and never touches unrelated versions.
