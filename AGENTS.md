# Agent Rules (always-on)

## Goal
Deliver working outcomes with proof (tests/logs/demo), not “some code”.

## Process
1) If task is non-trivial (3+ steps, architecture, migration, refactor, bug with unknown cause):
   - Produce a plan first (steps + risks + Definition of Done + verification commands).
   - Do not implement until plan exists (unless user explicitly says “skip plan”).

2) If things go sideways:
   - STOP. Re-plan. Don’t push forward blindly.

3) Bugfix procedure:
   - Repro -> evidence -> root cause -> minimal fix -> regression protection -> proof.

## Verification (mandatory)
Never claim done without at least one of:
- tests/lint/typecheck run (when relevant)
- repro confirmed fixed
- concrete demo (command output/logs/specific scenario)

## Minimal impact
- Touch only what’s necessary.
- No dependency changes without asking.
- No “beauty refactors” unless requested.

## Guardrails (stop & ask)
Ask for confirmation before:
- touching >15 files
- changing public API/contract/DB schema
- adding/bumping dependencies
- refactor mainly for aesthetics
- behavior change without explicit DoD + verification
