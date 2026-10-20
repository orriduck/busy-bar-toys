import asyncio
import unittest

from busybar_shared.preview_pipeline import LatestFrameBuffer
from busybar_shared.preview_session import supervise_preview_session


class LatestFrameBufferTest(unittest.IsolatedAsyncioTestCase):
    async def test_backpressure_is_lossy_not_fifo_or_replay(self):
        buffer = LatestFrameBuffer()
        self.assertIsNone(buffer.offer(1, {'sequence': 1}))
        for sequence in range(2, 100):
            self.assertEqual(buffer.offer(1, {'sequence': sequence}), 'supersededDropped')
        self.assertEqual(await buffer.get(), (1, {'sequence': 99}))
        self.assertTrue(buffer.empty())
        with self.assertRaises(asyncio.QueueEmpty):
            buffer.get_nowait()

    async def test_out_of_order_and_already_sent_frames_do_not_replace_pending(self):
        buffer = LatestFrameBuffer()
        buffer.offer(1, {'sequence': 9})
        self.assertEqual(buffer.offer(1, {'sequence': 8}), 'outOfOrderDropped')
        self.assertEqual(buffer.offer(1, {'sequence': 10}, last_sent=10), 'outOfOrderDropped')
        self.assertEqual(await buffer.get(), (1, {'sequence': 9}))

    async def test_generation_change_resets_sequence_without_replaying_old_pixels(self):
        buffer = LatestFrameBuffer()
        buffer.offer(1, {'sequence': 100})
        self.assertEqual(buffer.offer(2, {'sequence': 1}), 'invalidatedDropped')
        self.assertEqual(await buffer.get(), (2, {'sequence': 1}))
        buffer.offer(2, {'sequence': 2})
        self.assertEqual(buffer.discard(), 1)
        self.assertEqual(buffer.discard(), 0)
        self.assertTrue(buffer.empty())

    async def test_waiter_wakes_and_instances_do_not_share_frames(self):
        first, second = LatestFrameBuffer(), LatestFrameBuffer()
        waiting = asyncio.create_task(first.get())
        await asyncio.sleep(0)
        second.offer(1, {'sequence': 1})
        self.assertFalse(waiting.done())
        first.offer(2, {'sequence': 3})
        self.assertEqual(await waiting, (2, {'sequence': 3}))
        self.assertEqual(await second.get(), (1, {'sequence': 1}))


class PreviewSessionSupervisorTest(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, mode, *, invalidation_fails=False):
        started = asyncio.Event()
        finish = asyncio.Event()
        events = []

        async def worker():
            started.set()
            try:
                await asyncio.Future()
            finally:
                events.append('joined')

        async def ending():
            await finish.wait()
            if mode == 'error':
                raise RuntimeError('worker failed')

        def invalidate():
            events.append('invalidated')
            if invalidation_fails:
                raise ValueError('invalidation failed')

        task = asyncio.create_task(supervise_preview_session(
            (worker(), ending()), invalidate=invalidate))
        await started.wait()
        if mode == 'cancel':
            task.cancel()
        else:
            finish.set()
        result, = await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(events, ['invalidated', 'joined'])
        return result

    async def test_normal_member_completion_fences_and_joins_siblings(self):
        self.assertIsNone(await self.exercise('normal'))

    async def test_worker_failure_propagates_after_fencing_and_joining(self):
        result = await self.exercise('error')
        self.assertIsInstance(result, RuntimeError)
        self.assertEqual(str(result), 'worker failed')

    async def test_owner_cancellation_fences_and_joins_siblings(self):
        self.assertIsInstance(await self.exercise('cancel'), asyncio.CancelledError)

    async def test_cleanup_failure_still_joins_siblings(self):
        self.assertIsInstance(await self.exercise('normal', invalidation_fails=True), ValueError)
