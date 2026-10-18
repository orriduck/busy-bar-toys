"""GAMING rolls into the game title; the elapsed-time region stays independent."""
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageOps
from busybar_notifier.model import Notification
from busybar_notifier.display import detail_elements


def elapsed_text(seconds):
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f'{hours}:{minutes:02}:{seconds:02}' if hours else f'{minutes:02}:{seconds:02}'


@lru_cache(maxsize=3)
def game_icon(source):
    """Fit the official site mark to the LED region without stretching it."""
    with Image.open(Path(__file__).with_name('assets') / (source+'.png')) as original:
        mark = ImageOps.contain(original.convert('RGBA'), (16,14), Image.Resampling.LANCZOS)
    image = Image.new('RGB', (16,14), 'black')
    image.paste(mark, ((16-mark.width)//2, (14-mark.height)//2), mark)
    return image


def notification(game, seconds=None):
    return Notification('game','info',game.source,'GAMING',game.title,
                        '' if seconds is None else elapsed_text(seconds), note='Client open',
                        accent=game.accent,icon=game_icon(game.source).copy(),exit='source')


def time_element(game, seconds):
    return detail_elements(notification(game,seconds))[0]
