# Agent current-turn token counts plan

1. Add ingestion and rendering regressions before implementation.
2. Track reported usage per turn; restore baseline on bounded-tail bootstrap and preserve lifecycle behavior.
3. Replace network metrics in rendering, transitions and both service modes. Keep exact detail on the back display.
4. Update offline demo adapters, bilingual docs and the token-count clip. Inspect rendered pixels and actual current-turn ingestion.
5. Run the full suite, specification review, quality review and CI. Merge, reload the local service and verify actual usage on its cloud scene. Sync the agent handoff and canonical memory.
