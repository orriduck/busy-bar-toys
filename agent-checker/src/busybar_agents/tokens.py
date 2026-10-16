"""Model token rates from cumulative session totals. Inputs include cache; outputs include reasoning."""
from collections import deque
from dataclasses import dataclass
import time

RATE_WINDOW = 10


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int
    output_tokens: int

    def __post_init__(self):
        if any(type(value) is not int or value < 0
               for value in (self.input_tokens, self.output_tokens)):
            raise ValueError('Token counts must be nonnegative integers')


def parse_usage(value):
    if not isinstance(value, dict):
        return None
    try:
        return TokenUsage(value.get('input_tokens'), value.get('output_tokens'))
    except ValueError:
        return None


def compact_tokens(value):
    """Three glyphs per direction, decimal units, truncating instead of overstating."""
    if value is None:
        return '--'
    if type(value) is not int or value < 0:
        raise ValueError('Token count must be a nonnegative integer')
    if value < 1000:
        return str(value)
    for scale, suffix in ((1000, 'K'), (1000000, 'M'), (1000000000, 'G'), (1000000000000, 'T')):
        if value < scale * 100:
            return str(value // scale) + suffix
        if value < scale * 1000:
            return '.' + str(value // (scale * 100)) + {'K':'M','M':'G','G':'T','T':'P'}[suffix]
    return '+++'  # Compact overflow; the back display retains the exact integer.


class TokenRateMeter:
    """Per-session tokens per second over a sliding window of cumulative totals."""

    def __init__(self, window=RATE_WINDOW, clock=time.monotonic):
        self.window = window
        self.clock = clock
        self._samples = {}

    def rate(self, session, totals):
        if totals is None:
            self._samples.pop(session, None)
            return None
        now = self.clock()
        samples = self._samples.setdefault(session, deque())
        if samples and (totals.input_tokens < samples[-1][1].input_tokens
                        or totals.output_tokens < samples[-1][1].output_tokens):
            samples.clear()
        if not samples or samples[-1][1] != totals or now - samples[-1][0] >= 1:
            samples.append((now, totals))
        while len(samples) > 2 and now - samples[1][0] >= self.window:
            samples.popleft()
        start, first = samples[0]
        elapsed = max(now - start, 1)
        if len(samples) == 1:
            return TokenUsage(0, 0)
        return TokenUsage(int((totals.input_tokens - first.input_tokens) / elapsed),
                          int((totals.output_tokens - first.output_tokens) / elapsed))


METER = TokenRateMeter()


def task_usage(task, usage=None):
    """Explicit rates win (demos and previews); otherwise measure the task's session totals."""
    if usage is not None or task is None:
        return usage
    totals = getattr(task, 'token_usage', None)
    return None if totals is None else METER.rate(getattr(task, 'session_id', None), totals)
