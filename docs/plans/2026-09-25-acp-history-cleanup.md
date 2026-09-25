# ACP History Cleanup Implementation Plan

> For agentic workers: use subagent-driven-development with separate implementation and independent review.

**Goal:** Remove Pi-owned ACP history when its runtimes become idle, including interrupted startup history, without moving credentials or serializing inference.

**Architecture:** Explicit opt-in by the owned Pi integration to a macOS Python standard-library supervisor. A kernel advisory lock protects admission, persistent runtime records and cleanup. Runtime groups are registered before they can start Google ACP; the final verified exit clears only existing ACP conversations and brain content. The next launch reconciles dead owners. Existing upstream/default supervisor behavior stays unchanged.

**Tech stack:** Existing TypeScript adapter/Pi integration; macOS /usr/bin/python3 (verified 3.9.6), fcntl.flock, subprocess, descriptor-relative filesystem operations; Vitest subprocess fixtures and existing Pi live harness.

Asana execution root: https://app.asana.com/1/1210093358898223/task/1218852620564629

## Approved scope and boundaries

The user does not use or plan standalone Antigravity CLI. The existing ACP history roots therefore belong to this Pi integration. No dedicated profile, login migration, per-child token copies, new inference calls, permanent daemon, or production Gemini role mappings. Credentials/settings and unrelated sibling files remain intact. Global GEMINI_HOME/artifacts is outside the ACP-specific roots and remains untouched.

Activation must be explicit: only the owned Pi factory selects this supervisor. Before deployment, verify no legacy ACP runtime remains. Do not infer ownership from arbitrary filesystem changes or scan/delete unrelated profiles. Tests use disposable synthetic homes; production selection derives home from the same GEMINI_HOME/default resolution as the existing saved-login health check.

## Task 1 — supervisor and filesystem contract

Files: new src/acp/history-supervisor.py; src/acp/process.ts export; existing src/acp/index.ts export if required; new test/history-cleanup.test.ts and bounded fake-runtime fixtures.

- [ ] Write failing real-subprocess tests for opt-in cleanup of conversations/brain with byte-identical credential/settings sentinels and untouched unrelated files.
- [ ] Add the Python supervisor with a private coordination subdirectory under the ACP profile. Lock a stable regular file with fcntl.flock; never unlink the lock inode or take over a live holder by age.
- [ ] Under lock: validate paths/records, reconcile records whose supervisor and recorded runtime group are absent, and clean only when no live/ambiguous records remain. Corrupt records, permission errors and unsafe paths fail closed with sanitized diagnostics.
- [ ] Persist supervisor ownership before spawning a detached gate runner. The gate must receive START through its private control descriptor before launching the official runtime in the gate's group. Persist and sync the group record before sending START; EOF before START exits without launching ACP. This covers death during registration.
- [ ] Forward ACP stdio without protocol alteration. On EOF/signal/parent loss/agent exit, terminate and verify the entire owned runtime group, then retire its record under the lock. Group-leader exit alone is insufficient. Never signal a recovered stale group; a surviving or ambiguous group blocks cleanup.
- [ ] Cleanup preserves root identity and refuses symlinked history roots/coordination roots. Use descriptor-relative traversal so nested symlinks cannot redirect deletion; preserve the profile itself, its credentials and settings. Interruptions leave a recoverable record.
- [ ] Keep existing close():Promise<void> nonthrowing: upstream fire-and-forget teardown assumes it. Add opt-in shutdownGraceMs=10000 (default1500 unchanged), followed by a separate1000ms hard-kill wait. Supervisor bounds group-stop/lockwait/cleanup within that budget. Deferred cleanup exits nonzero with a sanitized diagnostic retained in ProcessExit, and keeps recoverable state; a terminated process alone must not be reported as successful history cleanup. Test actual AntigravityProcess.close() with lock contention and assert diagnostic/status plus safe next-launch recovery.
- [ ] Expose a small launch helper for the fixed Python/script path; unsupported/missing interpreter fails visibly. Do not accept model/tool-controlled cleanup paths.

## Task 2 — adversarial lifecycle tests

- [ ] Prove overlapping runtimes are simultaneously active; ending one does not delete the other's sentinel.
- [ ] Race a new admission with final cleanup; the kernel lock must exclude overlap.
- [ ] Cover normal completion, cancellation, controller loss, supervisor SIGKILL, pre-START gate loss, runtime failure before session ID, surviving group and next-launch recovery.
- [ ] Cover corrupt records, uncertain liveness, PID/group reuse conservatively, symlinked roots/children and unrelated sentinel preservation. No elapsed-time-only deletion.
- [ ] Run npm run check and npm run pack:check; independent sensitive-code and spec-compliance review. Commit/push only after checks pass.

## Task 3 — Pi wiring and deployed qualification

Files: prototype/subagents/src/antigravity-subscription-entry.ts, its test, root/prototype package manifests and locks; docs/runbooks/antigravity-subscription.md.

- [ ] Opt the bound child factory into the owned cleanup supervisor, preserving OAuth-only environment filtering, qualified runtime resolution and exact model/tool authority.
- [ ] Update both package pins to the reviewed adapter commit; ensure root and test lockfiles agree.
- [ ] Run Pi canonical validation and the deployed live Gemini read/question/cancel harness with the installed runtime resolver. Compare only file names/counts and credential/settings metadata; do not print secrets or raw history.
- [ ] Verify history empty after live cleanup and an unrelated sentinel survives; repeat bounded crash recovery without inference where possible.
- [ ] Independently review, publish default tracking branches, install locked dependencies, preserve Astra/medium defaults and record evidence in Asana. Close only this task; Gemini role mappings remain pending user discussion.

## Honest limits

Cleanup may wait until all concurrent ACP runtimes finish. A surviving/ambiguous group blocks deletion; no PID-only recovery kill. A machine crash is recovered on the next launch. Arbitrary hostile processes that escape their group require separate containment and are not silently assumed dead. No global-history sweep or deletion of other Gemini surfaces.
