"""Model token rates. Inputs exclude cache reads; outputs include reasoning.

The display shows the observed elapsed-time average of a session's latest
completed reply, as reported by its source (SourceUsage.throughput). A source
without trustworthy reply boundaries reports no throughput and shows --; its
cumulative totals are kept but never turned into a rate. The input value is
input accounting throughput: counted input divided by the reply duration. It is
not prefill or decoding speed.
"""
from dataclasses import dataclass


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


@dataclass(frozen=True)
class SourceUsage:
    """What a usage reader reports for one session."""
    totals: TokenUsage | None = None
    throughput: TokenUsage | None = None


ENDED_STATES = frozenset({"stopped", "unknown"})


def task_usage(task, usage=None):
    """Explicit rates win (demos and previews). Ended or stale sessions are unknown.

    A reported completed-reply throughput is shown as is and held until the next.
    """
    if usage is not None or task is None:
        return usage
    if getattr(task, 'state', None) in ENDED_STATES:
        return None
    return getattr(task, 'token_rate', None)
