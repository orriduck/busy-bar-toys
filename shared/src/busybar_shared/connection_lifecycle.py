"""In-process transport lifecycle only, with independent state for every lane.

This module knows no occurrences, queue records, acknowledgements, frames or
persistence. Closing/retrying a channel must never mutate those owners' state.
Callers provide protocol-specific operations and terminal-error classification.
"""
from dataclasses import dataclass


@dataclass
class RetryState:
    initial: float = 1
    maximum: float = 30
    delay: float = 1

    def progress(self):
        self.delay = self.initial

    def failed(self):
        delay = self.delay
        self.delay = min(delay * 2, self.maximum)
        return delay


class PeriodicChannel:
    """One stop-aware execution lane. Instances never share retry budgets."""
    def __init__(self, *, stop, operation, errors, terminal, on_error,
                 on_success=lambda: None, interval=.5):
        self.stop = stop
        self.operation = operation
        self.errors = errors
        self.terminal = terminal
        self.on_error = on_error
        self.on_success = on_success
        self.interval = interval
        self.retry = RetryState()

    def run(self):
        while not self.stop.is_set():
            try:
                self.operation()
                self.on_success()
                self.retry.progress()
            except self.errors as error:
                self.on_error(error)
                if self.terminal(error): return
                if self.stop.wait(self.retry.failed()): return
                continue
            if self.stop.wait(self.interval): return


class SnapshotStreamChannel:
    """Reconnect a stream; deliver ordered envelopes to a separate state owner.

    A clean EOF is a reconnect, not a queue reset. Progress is measured only after
    the owner accepted an envelope. Cancellation never manufactures an ack/end.
    """
    def __init__(self, *, stop, connect, deliver, errors, terminal, on_error):
        self.stop = stop
        self.connect = connect
        self.deliver = deliver
        self.errors = errors
        self.terminal = terminal
        self.on_error = on_error
        self.retry = RetryState()

    def run(self):
        while not self.stop.is_set():
            try:
                for envelope in self.connect():
                    if self.stop.is_set(): return
                    self.deliver(envelope)
                    self.retry.progress()
            except self.errors as error:
                self.on_error(error)
                if self.terminal(error): return
            if self.stop.wait(self.retry.failed()): return
