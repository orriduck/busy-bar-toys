"""Command line and per-user background service."""
import argparse
import fcntl
import getpass
import json
import logging
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import time

from busybar_shared.api import BusyAPI, APIError, AuthError, ConnectionError
from busybar_shared.credentials import read_token
from .display import make_payload, render, source_icon
from .events import Task, TaskRegistry, RolloutWatcher, load_dot_thread_ids
from .runtime import RUNTIME, SPOOL, hook_event, write_event, read_spool
from busybar_shared.frames import decode_frame
from .animation import ANIMATION_FILE, thinking_animation
from .network import NetworkSampler, NetworkRates
from .view import ViewMode, StandbyTimer
from busybar_shared.device_input import configured_input_monitor, read_input_status
from .motion import MotionDirector
from adsbao_checker.checker import configured_checker
from adsbao_checker.presenter import AircraftPresenter

LABEL = "app.busybar.ai-status"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
REPO = Path(__file__).resolve().parents[3]
LOG = logging.getLogger("busy-bar")


def _service(action, *, check=False):
    target = f"gui/{os.getuid()}/{LABEL}"
    args = ["/bin/launchctl", action, target]
    return subprocess.run(args, capture_output=True, text=True, check=check)


def install(*, reduced_motion=False):
    read_token()  # Fail before changing any service files if credentials aren't ready.
    from adsbao_checker.checker import read_config as read_aircraft_config
    if sys.platform == 'darwin' and read_aircraft_config(RUNTIME):
        subprocess.run([sys.executable, str(REPO / 'scripts/build-location-helper.py')], check=True)
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    logs = Path.home() / "Library/Logs/BusyBarAI"
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "busybar_status.cli", "watch"],
        "WorkingDirectory": str(REPO),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "StandardOutPath": str(logs / "service.log"),
        "StandardErrorPath": str(logs / "service.log"),
    }
    if reduced_motion:
        config['ProgramArguments'].append('--reduced-motion')
    _service("bootout")
    PLIST.write_bytes(plistlib.dumps(config))
    PLIST.chmod(0o600)
    # bootout can return before launchd releases the old registration. Retry only
    # that transient local EIO; other setup errors remain immediate failures.
    # Up to 10s for an in-flight request plus 10s for scoped final cleanup.
    for attempt in range(51):
        result = subprocess.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)],
                                capture_output=True, text=True)
        if result.returncode != 5 or attempt == 50:
            break
        time.sleep(0.5)
    if result.returncode:
        raise RuntimeError("Could not load the per-user BUSY Bar service.")
    print("BUSY Bar service installed. Starts now and at login.")


def uninstall():
    _service("bootout")
    PLIST.unlink(missing_ok=True)
    print("BUSY Bar service removed. Keychain token retained.")


def watch(args):
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    lock = (RUNTIME / "watch.lock").open("w")
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("The BUSY Bar observer is already running.") from None
    try:
        client = BusyAPI(read_token())
    except AuthError:
        LOG.error("Keychain unavailable. Unlock/authorize it, then reinstall to resume.")
        lock.close()
        return 0
    registry = TaskRegistry()
    dot_ids = load_dot_thread_ids(Path.home() / ".codex/.codex-global-state.json")
    dot_ids.update(args.dot_thread)
    watcher = RolloutWatcher(Path.home() / ".codex/sessions", registry, dot_ids)
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_draw = 0.0
    last_scan = 0.0
    last_dot_refresh = 0.0
    last_spool = {}
    backoff = 5
    owned = False
    last_state = None
    network = NetworkSampler()
    rates = None
    next_sample = 0
    motion = MotionDirector(client, reduced=getattr(args, 'reduced_motion', False))
    view = ViewMode(RUNTIME / "view.json")
    standby_timer = StandbyTimer()
    monitor = configured_input_monitor(RUNTIME)
    last_input_status = 0
    aircraft = configured_checker(RUNTIME, REPO)
    plane = AircraftPresenter(client, reduced=getattr(args, 'reduced_motion', False)) if aircraft else None
    last_aircraft_poll = 0
    candidate = None
    alert_retry = 0
    dismiss_plane = False
    device_retry_at = 0
    try:
        monitor.start()
        if aircraft:
            aircraft.start()
        while not stopping:
            now = time.time()
            if now - last_dot_refresh >= 60:
                watcher.dot_thread_ids = load_dot_thread_ids(Path.home() / ".codex/.codex-global-state.json") | set(args.dot_thread)
                last_dot_refresh = now
            if now - last_scan >= 1:
                watcher.poll(now)
                last_scan = now
            for event in read_spool(now=now):
                key = event.get("session_id", "")
                stamp = event.get("timestamp")
                if last_spool.get(key) != stamp:
                    if key in watcher.dot_thread_ids: event["source"] = "dots"
                    registry.ingest(event, now)
                    last_spool[key] = stamp
            task = registry.select(now)
            turns = registry.active_turns(now)
            known_turns = registry.known_turns()
            was_calendar = view.calendar
            if monitor.pop_start_pressed():
                view.dismiss(known_turns)
                dismiss_plane = bool(plane and plane.active)
                LOG.info("View: calendar")
                next_draw = min(next_draw, now)
            allowed = view.allows(turns, known_turns=known_turns)
            standby = task is None or task.state in {"done", "stopped"}
            if not allowed or not standby or (plane and plane.active):
                standby_timer.reset()
            elif standby_timer.expired(time.monotonic()):
                view.dismiss(known_turns)
                allowed = False
                next_draw = min(next_draw, now)
                LOG.info("View: calendar (standby 10s)")
            if was_calendar != view.calendar:
                next_draw = min(next_draw, now)
                if not view.calendar: LOG.info("View: codex")
            if now-last_input_status >= 5:
                monitor.write_status(RUNTIME / "input-status.json")
                if aircraft:
                    try: aircraft.write_status(active=plane.active)
                    except OSError: LOG.warning("Could not save aircraft diagnostics.")
                last_input_status = now
            if aircraft and now-last_aircraft_poll >= 1:
                try: candidate = aircraft.poll(now)
                except (OSError, ValueError):
                    candidate = None
                    LOG.warning("Aircraft observation unavailable.")
                last_aircraft_poll = now
            signature = (task.session_id, task.turn_id, task.state) if task else None
            if signature != last_state:
                LOG.info("State: %s", task.state if task else "idle")
                last_state = signature
                next_draw = min(next_draw, now)
            needs_display = now >= next_draw or motion.due or (plane and plane.active) or (candidate and time.monotonic() >= alert_retry)
            if needs_display and time.monotonic() >= device_retry_at:
                try:
                    if plane and not plane.active and candidate and time.monotonic() >= alert_retry:
                        if plane.start(candidate):
                            owned = True
                            motion.invalidate()
                            standby_timer.reset()
                            try: aircraft.mark_alerted(candidate, now)
                            except OSError: LOG.warning("Could not save aircraft encounter metadata.")
                        candidate = None
                        alert_retry = time.monotonic() + 5
                    if plane and plane.active:
                        if dismiss_plane:
                            plane.dismiss()
                            dismiss_plane = False
                        if plane.advance():
                            motion.invalidate()
                            next_draw = now
                            if not allowed:
                                client.clear()
                                owned = False
                    if (not plane or not plane.active) and now >= next_draw:
                        if allowed:
                            sample_tick = time.monotonic()
                            if sample_tick >= next_sample:
                                rates = network.sample()
                                next_sample = sample_tick + 5
                            motion.show(task, now, registry.active_count(now), rates)
                        elif motion.visible:
                            motion.hide()
                        next_draw = now + 5
                    if (not plane or not plane.active) and motion.due:
                        motion.advance()
                    owned = motion.visible or bool(plane and plane.active) or owned
                    backoff = 5
                    device_retry_at = 0
                except AuthError:
                    LOG.error("Authentication stopped the observer. Check Keychain and reinstall to resume.")
                    return 0  # No automatic authentication retry storm in launchd.
                except (ConnectionError, APIError):
                    owned = motion.visible or bool(plane and plane.active) or owned
                    motion.cancel()
                    LOG.warning("Device unavailable; retry in %s seconds.", backoff)
                    device_retry_at = time.monotonic() + backoff
                    next_draw = now + backoff
                    backoff = min(backoff * 2, 60)
            if allowed and standby and motion.standby_visible and not (plane and plane.active):
                standby_timer.shown(time.monotonic())
            time.sleep(0.05 if motion.pending else 0.25)
    finally:
        if aircraft:
            aircraft.stop()
        monitor.stop()
        monitor.write_status(RUNTIME / "input-status.json")
        if owned:
            try: client.clear()
            except APIError: pass
        lock.close()
    return 0


def preview(args):
    from PIL import Image, ImageDraw
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    cards = []
    now = time.time()
    for source in ("chatgpt", "dots"):
        for state in ("working", "waiting", "done", "error"):
            task = Task("preview", "preview", source, "busy-bar", state, now-125, now)
            front, back = render(task, now, 2, NetworkRates(1536, 850*1024, "preview"))
            front.save(out / f"{source}-{state}-front.png")
            back.save(out / f"{source}-{state}-back.png")
            card = Image.new("RGB", (600, 230), "#11151D")
            draw = ImageDraw.Draw(card)
            draw.text((20, 12), f"{source.upper()} / {state.upper()}", fill="white")
            card.paste(front.resize((504, 112), Image.Resampling.NEAREST), (20, 38))
            card.paste(back.resize((128, 64), Image.Resampling.NEAREST), (20, 157))
            cards.append(card)
    sheet = Image.new("RGB", (1200, 920), "#11151D")
    for i, card in enumerate(cards): sheet.paste(card, ((i//4)*600, (i%4)*230))
    sheet.save(out / "preview.png")
    print(out / "preview.png")


def demo(args):
    client = BusyAPI(read_token())
    started = time.time()
    network = NetworkSampler()
    task = Task("demo", "demo", args.source, "DEMO", args.state, started, started)
    try:
        if task.state == "working":
            client.upload_asset(ANIMATION_FILE, thinking_animation())
        end = started + args.seconds
        while time.time() < end:
            if not client.draw(make_payload(task, time.time(), 1, network.sample())):
                print("Display suppressed by focus mode.")
                return 0
            time.sleep(min(5, max(0, end-time.time())))
    finally:
        client.clear()


def motion_demo(args):
    """Show a finite DEMO with synthetic clock and rate changes."""
    client=BusyAPI(read_token())
    motion=MotionDirector(client,reduced=args.reduced_motion)
    sequence=[('working','chatgpt',1024,2048),('working','chatgpt',2048,4096),
              ('waiting','chatgpt',0,6144),('working','dots',12288,24576),
              ('error','dots',1024**2,256*1024),('done','chatgpt',0,0)]
    try:
        motion.prepare()
        started=time.monotonic();wall=time.time();previous=-1
        while time.monotonic()-started<args.seconds:
            phase=min(5,int((time.monotonic()-started)*6/args.seconds))
            if phase!=previous:
                state,source,up,down=sequence[phase]
                task=Task('demo',str(phase),source,'DEMO',state,wall,wall)
                motion.show(task,wall+phase*60,1,NetworkRates(up,down,'DEMO'))
                previous=phase
            motion.advance()
            time.sleep(.05)
        motion.hide()
        while motion.pending:
            motion.advance();time.sleep(.05)
    finally:
        client.clear()


def capture(args):
    client = BusyAPI(read_token())
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    for index in (0, 1):
        image = decode_frame(client.frame(index), index)
        image.save(out / ("device-front.png" if index == 0 else "device-back.png"))
    print("Device framebuffers saved to", out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    observe = sub.add_parser("watch", help="Watch local Codex lifecycle events")
    observe.add_argument("--dot-thread", action="append", default=[], help="Explicit dots identity override; never fabricates status")
    observe.add_argument("--reduced-motion", action="store_true", help="Use static lights and direct display changes")
    setup = sub.add_parser('install')
    setup.add_argument('--reduced-motion', action='store_true', help='Install the service without motion effects')
    for name in ("status", "uninstall", "clear", "token-set", "input-wifi"):
        sub.add_parser(name)
    for name in ("preview", "capture"):
        command = sub.add_parser(name)
        command.add_argument("--output", default=".local/"+name)
    command = sub.add_parser("demo", help="Show a finite, explicitly labeled demo")
    command.add_argument("--source", choices=("chatgpt", "dots"), default="chatgpt")
    command.add_argument("--state", choices=("working", "waiting", "done", "error", "stopped"), default="working")
    command.add_argument("--seconds", type=int, choices=range(1,61), default=5, metavar="1..60")
    command=sub.add_parser('motion-demo',help='Show finite DEMO transitions with synthetic clock and rates')
    command.add_argument('--seconds',type=int,choices=range(6,31),default=18,metavar='6..30')
    command.add_argument('--reduced-motion',action='store_true')
    command = sub.add_parser("emit", help="Emit a real lifecycle state from an external tool")
    command.add_argument("state", choices=("working", "waiting", "done", "error", "stopped"))
    command.add_argument("--source", choices=("chatgpt", "dots"), default="chatgpt")
    command.add_argument("--session-id", required=True)
    command.add_argument("--turn-id", required=True)
    command.add_argument("--project", default="AI task")
    command = sub.add_parser("hook", help="Consume structured hook JSON on stdin")
    command.add_argument("--source", choices=("chatgpt", "dots"), default="chatgpt")
    from adsbao_checker.commands import register as register_aircraft_commands
    register_aircraft_commands(sub)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        if args.command.startswith('adsbao-'):
            from adsbao_checker.commands import run as run_aircraft_command
            return run_aircraft_command(args, RUNTIME, REPO)
        if args.command == "watch": return watch(args)
        if args.command == "install": return install(reduced_motion=args.reduced_motion)
        if args.command == "uninstall": return uninstall()
        if args.command == "preview": return preview(args)
        if args.command == "capture": return capture(args)
        if args.command == "demo": return demo(args)
        if args.command == 'motion-demo': return motion_demo(args)
        if args.command == "clear": return BusyAPI(read_token()).clear() and 0
        if args.command == "input-wifi":
            from busybar_shared.credentials import INPUT_HELPER
            from busybar_shared.wifi_setup import configure_wifi
            if not INPUT_HELPER.exists():
                raise RuntimeError("Compile scripts/input-keychain.swift first; see README.")
            configure_wifi(BusyAPI(read_token()), RUNTIME)
            print("Wi-Fi input configured. Run install, then check button_input.connected in status.")
            return 0
        if args.command == "status":
            state = BusyAPI(read_token()).status()
            service = _service("print")
            from adsbao_checker.checker import read_status as read_aircraft_status
            print(json.dumps({"connected": True, "firmware": state.get("firmware", {}).get("version"),
                              "api": state.get("system", {}).get("api_semver"),
                              "service_loaded": service.returncode == 0,
                              "service_running": "state = running" in service.stdout,
                              "view": "calendar" if ViewMode(RUNTIME / "view.json").calendar else "codex",
                              "adsbao": read_aircraft_status(RUNTIME),
                              "button_input": read_input_status(RUNTIME / "input-status.json")
                                  if "state = running" in service.stdout else {"connected": False}}, indent=2))
        elif args.command == "token-set":
            helper = REPO / ".venv/bin/busy-token-store"
            if not helper.exists(): raise RuntimeError("Compile scripts/store-token.swift first; see README.")
            secret = getpass.getpass("BUSY Bar token: ")
            result = subprocess.run([str(helper)], input=secret, text=True, capture_output=True)
            if result.returncode: raise RuntimeError("Keychain store failed.")
            print("Token stored in macOS Keychain.")
        elif args.command == "emit":
            write_event(SPOOL, {"session_id": args.session_id[:200], "turn_id": args.turn_id[:200],
                               "cwd": Path(args.project).name, "source": args.source,
                               "state": args.state, "timestamp": time.time()})
        elif args.command == "hook":
            raw = sys.stdin.buffer.read(1_048_577)
            if len(raw) > 1_048_576: return 0
            try: event = hook_event(json.loads(raw), source=args.source)
            except (ValueError, UnicodeError): return 0
            if event: write_event(SPOOL, event)
        return 0
    except (APIError, RuntimeError, OSError, ValueError) as error:
        LOG.error("%s", error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
