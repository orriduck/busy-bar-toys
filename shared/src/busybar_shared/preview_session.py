"""Preview task lifetime, independent of pixels, capture and service queue state."""
import asyncio


async def supervise_preview_session(work, *, invalidate):
    """End the session when any member ends; fence work before cancel/join.

    The owner supplies protocol workers and synchronous invalidation. This
    supervisor neither reconnects nor retries frames: the bridge retains its
    authentication, lease, permission, diagnostic and reconnect policy.
    """
    tasks = [asyncio.create_task(coroutine) for coroutine in work]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        try:
            invalidate()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
