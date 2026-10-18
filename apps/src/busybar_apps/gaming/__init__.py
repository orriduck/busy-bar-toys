"""Game profiles. Client inventory and installation paths stay on the Mac."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Game:
    source: str
    title: str
    name: str
    bundle_id: str
    path_suffix: str
    accent: tuple


GAMES = (
    Game('wow', 'WOW', 'World of Warcraft', 'com.blizzard.worldofwarcraft',
         '/_retail_/World of Warcraft.app', (255, 190, 69)),
    Game('wow-forever', 'WOW FOREVER', 'WoW Forever', 'com.blizzard.worldofwarcraft',
         '/_classic_beta_/World of Warcraft Beta.app', (119, 168, 255)),
    Game('maplestory', 'MAPLESTORY', 'MapleStory', 'com.nexon.maplestoryna_exe',
         '/MapleStory.app', (119, 220, 161)),
)
