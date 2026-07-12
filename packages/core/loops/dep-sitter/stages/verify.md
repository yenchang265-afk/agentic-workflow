Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.upgrade}}Upgrade summary:
{{artifacts.upgrade}}{{/artifacts.upgrade}}
---
Check the upgrade landed exactly as ordered and nothing else moved: the dependency resolves at the target version (npm: `npm ls <pkg>`; Maven: `mvn dependency:tree`; Gradle: `./gradlew dependencyInsight --dependency <artifact>`), the advisory is gone from the work order's report command (`npm audit`, or `osv-scanner --format json -L <file>`), the diff touches only the build/lock files plus the fallout the summary names, and the test suite passes locally. Record the verdict via loop_verdict: PASS only when all of that holds; FAIL with the gaps otherwise; ERROR when the checks themselves could not run.
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
