# Git isolation

What `state.git.base` and `git.branch` mean, where a run's tree is left, and
why the base is pinned at the start. The failures here are silent and
expensive: a diff boundary that grades the wrong range, or task N+1 containing
task N.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## `state.git.base` is a ref, not always a branch

`taskBranch: false` runs the loop on the branch the tree already has checked
out. There base and branch would name the SAME ref, so `git diff <base>...<branch>`
is empty and REVIEW grades nothing — hence `base` holds HEAD's **sha** at the
first BUILD instead. That makes it polymorphic, and `git.onCurrentBranch` is the
only discriminant. The sharp edge is `checkoutBranch`, which falls through to
`git checkout -b <ref>` when the ref is not a branch: handed a sha it invents a
branch named after a commit and strands the human on it. Anything
reading `base` as a branch NAME must check the flag first — and `persist.ts`'s
`GitRefSchema` must carry it, because zod strips unknown keys and a
snapshot-resumed run would otherwise lose it and hit exactly that.

That same fall-through is why `ensureIsolation` probes `branchExists` before
checking a base out. It is not defensive noise: the base can come from
`init.defaultBranch` or a host-supplied `baseBranch`, neither of which is
guaranteed to exist locally, and creating it from a parked work branch would
produce a "base" that is a copy of the last task's tip — the stacking bug below,
wearing a respectable name.

Two more things this mode's shape forces, both learned from a real-git test:

- **Its machine state cannot live in the working tree.** This is the one mode
  whose checkpoints `git add -A` the human's own checkout, so the
  one-run-per-tree marker sits under `<git-common-dir>`; in the backlog it rode
  straight into the user's feature commits.
- **`taskBranch` is engineering-only** (`taskBranchFor`). `pr-sitter` and
  `main-sitter` get their branch from the work source, and `dep-sitter`'s publish
  stage pins `git push origin feature/*` in a manifest that ships read-only
  inside the core package — a prefix override there makes its own guard deny its
  push.

## The loop leaves the tree on the work branch; the BASE is pinned at the start

A run ends where the work is. `teardownIsolation` used to return a shared tree
(`worktreesDir: false`) to `base`, and every human act after a run — read the
diff, amend, push, open the PR — is on `feature/<id>`, so the checkout put them
one branch away from it, silently, right after the toast saying the work was
ready. It now only logs. Do not restore the checkout.

The correctness that checkout was silently providing has to be re-provided at the
OTHER end, and this is the half to keep: a tree parked on the last run's branch
made `ensureIsolation` cut the next task from it (`base` was just "whatever is
checked out"), so task N+1 contained task N — in REVIEW's `base...branch` diff and
in the PR, as commits it never wrote. So `baseOffTaskBranch` redirects a base
inside the loop's own namespace (`taskBranchPrefix`) to the repo's default branch,
and the shared arm checks that base out BEFORE `checkout -b`. Three constraints:

- **Only the loop's own namespace is redirected.** A human on `my-work` is on a
  deliberate base; hijacking it to the default branch throws that away.
- **Never record a base the branch was not cut from.** `base` is REVIEW's diff
  boundary, so a fictional one grades the wrong range. Every degradation
  (unresolvable default branch, failed checkout) reports where we actually stand
  and warns — a wider diff is recoverable, a wrong one is not.
- **Shared mode's backlog writes now land on the work branch.** Only visible with
  `ignoreBacklog: false`; that is the accepted price of not switching, not a bug
  to fix by reintroducing a checkout.
