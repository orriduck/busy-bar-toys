# Current-turn token counts on the agent checker

The user corrected the lower agent-checker row: it must show model input/output token counts, not Mac network speed. They selected cumulative usage for the current turn. A new turn resets the counters. Preserve clock, source icon, state glow and native digit motion.

Read Codex rollout event_msg/token_count info using its reported input_tokens and output_tokens. Use cumulative counters to cover missed intermediate events, subtract the known pre-turn baseline, and never count a duplicate twice. Do not add cached_input_tokens or reasoning_output_tokens again. Keep sessions and ignored subagents isolated. A restart or bounded-tail bootstrap must recover the current turn without including earlier turns. Reject malformed/out-of-order data, handle counter resets without negative values or fabricated precision, and leave genuinely unavailable usage unknown.

The front display has two compact values: amber input up-arrow and cyan output down-arrow. Keep the calendar-like alignment. The back display shows exact input/output counts. Use decimal count abbreviations, never bytes or per-second units. Retain digit rolls and field fades when representation changes, including independent changes to either direction. Unsupported sources show unknown counts; demonstrations use explicit synthetic counts.

Standalone, cloud, CLI previews and offline demo renderers must use the same token data. Production paths must no longer sample the default network interface for this display. The cloud scheduler, services, credentials, button/calendar behavior and paused FPS work stay unchanged. Document the reported-count basis and uncertainty. Refresh the token-count README clip; retain clearly marked historical media if it cannot be regenerated this run.

Verify parser turn boundaries, duplicate/reset/malformed records, tail bootstrap/restart, session isolation, cache/reasoning non-duplication, both directional render values and bounds, native transitions and both service modes. Review independently, run CI, merge and reload the local service, then verify a live scene from actual local Codex usage without publishing fake production values.
