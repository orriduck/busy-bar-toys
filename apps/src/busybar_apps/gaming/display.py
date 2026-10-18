"""GAMING rolls into the game title; the elapsed-time region stays independent."""
from PIL import Image, ImageDraw
from busybar_notifier.model import Notification
from busybar_notifier.display import detail_elements


def elapsed_text(seconds):
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f'{hours}:{minutes:02}:{seconds:02}' if hours else f'{minutes:02}:{seconds:02}'


def controller_icon(accent):
    image = Image.new('RGB', (16,14), 'black')
    draw = ImageDraw.Draw(image)
    draw.polygon([(3,3),(12,3),(15,11),(12,12),(9,9),(6,9),(3,12),(0,11)], fill='#B8B8B8')
    draw.line((2,6,6,6), fill='black');draw.line((4,4,4,8), fill='black')
    draw.point((11,5), fill=accent);draw.point((13,7), fill=accent)
    return image


def notification(game, seconds=None):
    return Notification('game','info',game.source,'GAMING',game.title,
                        '' if seconds is None else elapsed_text(seconds), note='Client open',
                        accent=game.accent,icon=controller_icon(game.accent),exit='source')


def time_element(game, seconds):
    return detail_elements(notification(game,seconds))[0]
