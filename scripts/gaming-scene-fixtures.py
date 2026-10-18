#!/usr/bin/env python3
"""Generate offline MOCK cloud scenes using the actual Python game renderer."""
import argparse
import json
from pathlib import Path
import tempfile
from busybar_apps.gaming import GAMES
from busybar_shared.cloud import Producer
from busybar_service.game_watch import GameRenderer


def fixtures():
    result=[]
    with tempfile.TemporaryDirectory() as root:
        for game in GAMES:
            for reduced in (False,True):
                producer=Producer(Path(root),{'role':game.source+str(reduced),'serviceId':'MOCK-game',
                    'instanceId':'MOCK-mac','epoch':'MOCK-epoch'},None,clock=lambda:100,notify=lambda *_:None)
                renderer=GameRenderer(producer,game,reduced=reduced)
                renderer.show('MOCK-session',10)
                record=producer.state.records['game'];record['acked']=record['version']
                renderer.show('MOCK-session',11)
                record=producer.state.records['game']
                result.append({'source':game.source,'reduced':reduced,'scene':record['scene'],'update':record['update']})
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'control-plane/tests/fixtures/gaming-scenes.json')
    args=parser.parse_args()
    args.output.write_text(json.dumps(fixtures(),indent=2)+'\n')
    print(args.output)
