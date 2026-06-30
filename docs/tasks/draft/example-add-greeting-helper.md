---
title: Add a greeting() helper with a test
priority: 0
acceptance:
  - greeting("Ada") returns the string "Hello, Ada!"
  - A unit test covers the happy path and an empty-name case
---
Example task showing the schema. Add a small `greeting(name)` helper and a test
for it. Move this file to `../approved/` and run `/loop next` to drive it through
explore → plan → build → verify.
