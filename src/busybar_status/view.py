"""Persist a user-dismissed overlay until a new task turn actually appears."""
import json
import os
from pathlib import Path
import tempfile


class ViewMode:
    def __init__(self, path):
        self.path = Path(path)
        self.calendar = False
        self._blocked = frozenset()
        try:
            with self.path.open() as stream:
                data = json.loads(stream.read(1_048_577))
            if not isinstance(data,dict) or type(data.get('calendar')) is not bool:
                raise ValueError('Invalid saved view')
            turns=data.get('blocked_turns',[])
            if not isinstance(turns,list) or any(not isinstance(t,list) or len(t)!=2 or
                                                not all(isinstance(v,str) for v in t) for t in turns):
                raise ValueError('Invalid saved turns')
            self.calendar = data['calendar']
            self._blocked = frozenset(map(tuple,turns))
        except FileNotFoundError:
            pass
        except (OSError,ValueError,TypeError):
            # An unreadable dismissal must not unexpectedly seize the screen.
            self.calendar = True
            self._blocked = None

    def _save(self):
        self.path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as stream:
            temp=Path(stream.name)
            try:
                json.dump({'calendar':self.calendar,'blocked_turns':sorted(self._blocked or ())},stream)
                stream.flush()
                os.fsync(stream.fileno())
                temp.replace(self.path)
            finally:
                temp.unlink(missing_ok=True)

    def dismiss(self, known_turns):
        if self.calendar:
            return
        self.calendar = True
        self._blocked = frozenset(known_turns)
        self._save()

    def allows(self, active_turns, *, known_turns=None):
        active_turns = frozenset(active_turns)
        if not self.calendar:
            return True
        if self._blocked is None:
            self._blocked = frozenset(known_turns) if known_turns is not None else active_turns
            self._save()
        elif active_turns-self._blocked:
            self.calendar = False
            self._blocked = frozenset()
            self._save()
            return True
        return False


class StandbyTimer:
    """Ten seconds of actually displayed standby, independent of clock changes."""
    def __init__(self):
        self._since = None

    def shown(self, now):
        if self._since is None:
            self._since = now

    def reset(self):
        self._since = None

    def expired(self, now):
        return self._since is not None and now-self._since >= 10
