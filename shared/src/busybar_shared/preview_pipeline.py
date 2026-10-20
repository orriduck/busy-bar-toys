"""Ephemeral latest-frame handoff, deliberately NOT a reliable service queue.

All calls belong to one asyncio loop. There is one pending frame, no persistence,
acknowledgement, replay, or retry. The bridge owns permission/generation/display
checks and rechecks them after dequeue and send; this buffer owns only ordering
and replacement of frames already admitted by those checks.
"""
import asyncio


class LatestFrameBuffer:
    """Lossy capacity-one buffer. Offer never blocks a capture completion."""
    def __init__(self):
        self._queue = asyncio.Queue(maxsize=1)

    def empty(self):
        return self._queue.empty()

    def offer(self, generation, frame, *, last_sent=0):
        """Return the diagnostic reason for the one discarded frame, if any.

        Generations are opaque session tokens, not sequence numbers. Callers
        must reject stale completions before offering. A new generation may
        restart sequence numbering; within a generation the newest wins.
        """
        if frame['sequence'] <= last_sent:
            return 'outOfOrderDropped'
        reason = None
        if not self._queue.empty():
            queued_generation, queued = self._queue.get_nowait()
            if queued_generation == generation and queued['sequence'] > frame['sequence']:
                self._queue.put_nowait((queued_generation, queued))
                return 'outOfOrderDropped'
            reason = 'supersededDropped' if queued_generation == generation else 'invalidatedDropped'
        self._queue.put_nowait((generation, frame))
        return reason

    async def get(self):
        return await self._queue.get()

    def get_nowait(self):
        return self._queue.get_nowait()

    def discard(self):
        """Drop pending pixels only; callers record their context-specific reason."""
        if self._queue.empty():
            return 0
        self._queue.get_nowait()
        return 1
