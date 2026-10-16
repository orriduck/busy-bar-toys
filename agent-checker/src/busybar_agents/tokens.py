"""Model token counts. Inputs already include cache; outputs include reasoning."""
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


def task_usage(task, usage=None):
    return usage if usage is not None else getattr(task, 'token_usage', None)
