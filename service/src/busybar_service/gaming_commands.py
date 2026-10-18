"""Explicit local game enrollment and bounded diagnostics."""
import json
from pathlib import Path
import subprocess
import sys
import time
from busybar_apps.gaming import GAMES
from .cloud_registration import load_computer, register_service


def setup_games(runtime, repo):
    load_computer(runtime)  # Never infer a new computer or borrow another role.
    subprocess.run([sys.executable,str(repo/'scripts/build-app-observer.py')],check=True)
    for game in GAMES:
        config = register_service(runtime,game.source,name=game.name,template='custom',
                                  source=game.source,priority_group='dispensable')
        print(game.name+': '+config['services'][game.source]['serviceId'])
    print('Game services registered. Run busy-bar install --mode cloud to start collection.')
    return 0


def game_status(runtime):
    path=Path(runtime)/'gaming-status.json'
    try:
        value=json.loads(path.read_bytes()[:16384])
        if not isinstance(value,dict):raise ValueError()
        if not -5 <= time.time()-value.get('updatedAt',0) <= 15:
            value={'status':'stale','services':value.get('services',[]),'running':[]}
    except (OSError,ValueError):
        value={'status':'not-running','services':[],'running':[]}
    print(json.dumps(value,indent=2))
    return 0 if value.get('status')=='ready' else 1
