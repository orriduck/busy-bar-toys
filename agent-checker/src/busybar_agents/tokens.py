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
    """Per-session tokens per second from observed cumulative totals.

    Observers sample every live session about once a second, independent of
    which task is on screen. The rate is the change between the newest sample
    and the newest one at least `window` seconds older. Until a full window
    exists it covers the observed span, and it is unknown below one second.
    A gap longer than the window, a counter decrease or unavailable totals
    restart the samples, so a long unobserved delta is never shown as a rate.
    """

    def __init__(self, window=RATE_WINDOW, clock=time.monotonic):
        self.window = window
        self.clock = clock
        self._samples = {}

    def observe(self, session, totals):
        if totals is None:
            self._samples.pop(session, None)
            return
        now = self.clock()
        samples = self._samples.setdefault(session, deque())
        if samples and (now - samples[-1][0] > self.window
                        or totals.input_tokens < samples[-1][1].input_tokens
                        or totals.output_tokens < samples[-1][1].output_tokens):
            samples.clear()
        if not samples or samples[-1][1] != totals or now - samples[-1][0] >= 1:
            samples.append((now, totals))
        while len(samples) > 1 and samples[-1][0] - samples[1][0] >= self.window:
            samples.popleft()

    def rate(self, session):
        samples = self._samples.get(session)
        if not samples or self.clock() - samples[-1][0] > self.window:
            return None
        (start, first), (end, last) = samples[0], samples[-1]
        if end - start < 1:
            return None
        return TokenUsage(int((last.input_tokens - first.input_tokens) / (end - start)),
                          int((last.output_tokens - first.output_tokens) / (end - start)))

    def retain(self, sessions):
        for session in set(self._samples) - set(sessions):
            del self._samples[session]


METER = TokenRateMeter()


def task_usage(task, usage=None):
    """Explicit rates win (demos and previews); otherwise measure the task's session totals."""
    if usage is not None or task is None:
        return usage
    session = getattr(task, 'session_id', None)
    METER.observe(session, getattr(task, 'token_usage', None))
    return METER.rate(session)
