"""Command line and per-user background service."""
import argparse
import fcntl
import getpass
import json
import logging
import os
from pathlib import Path
from queue import Empty, SimpleQueue
import plistlib
import signal
import subprocess
import sys
import threading
import time

from busybar_shared.api import BusyAPI, APIError, AuthError, ConnectionError
from busybar_shared.credentials import read_token
from busybar_shared.lease import DisplayLease
from busybar_agents.display import make_payload, render, source_icon
from busybar_agents.events import Task
from busybar_agents import profiles
from busybar_apps import load_agents
from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry, RolloutWatcher
from busybar_apps.dots.orbit import load_dot_thread_ids
from busybar_agents.runtime import RUNTIME, SPOOL, hook_event, read_event, write_event, read_spool
from busybar_shared.frames import decode_frame
from busybar_agents.animation import ANIMATION_FILE, thinking_animation
from busybar_agents.network import NetworkSampler, NetworkRates
from busybar_agents.view import ViewMode, StandbyTimer
from busybar_shared.device_input import configured_input_monitor, read_input_status
from busybar_agents.motion import MotionDirector
from busybar_apps.adsbao.checker import configured_checker
from busybar_apps import NOTIFIER_APPS, notifier_sources
from busybar_apps.adsbao.source import aircraft_source
from busybar_notifier.config import display_settings, read_config as read_notifier_config
from busybar_notifier.model import status_color
from busybar_notifier.presenter import NotificationPresenter
from busybar_notifier.queue import NotificationQueue
from busybar_notifier.source import Poller

LABEL = "app.busybar.ai-status"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
REPO = Path(__file__).resolve().parents[3]
LOG = logging.getLogger("busy-bar")
INBOX = RUNTIME / "inbox"
SPAWN = None


def _spawn(work):
    (SPAWN or (lambda job: threading.Thread(target=job, daemon=True).start()))(work)
load_agents()


def _service(action, *, check=False):
    target = f"gui/{os.getuid()}/{LABEL}"
    args = ["/bin/launchctl", action, target]
    return subprocess.run(args, capture_output=True, text=True, check=check)


def install(*, reduced_motion=False, mode="standalone"):
    if mode == "cloud":
        from .cloud_watch import configurations
        configurations(RUNTIME)
    else:
        read_token()  # Fail before changing any service files if credentials aren't ready.
    from busybar_apps.adsbao.checker import read_config as read_aircraft_config
    if mode == 'standalone' and sys.platform == 'darwin' and read_aircraft_config(RUNTIME):
        subprocess.run([sys.executable, str(REPO / 'scripts/build-location-helper.py')], check=True)
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    logs = Path.home() / "Library/Logs/BusyBarAI"
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "busybar_service.cli", "watch"],
        "WorkingDirectory": str(REPO),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        # Notifier apps run the user's command-line tools; launchd does not inherit the shell PATH.
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")},
        "StandardOutPath": str(logs / "service.log"),
        "StandardErrorPath": str(logs / "service.log"),
    }
    if mode == 'cloud':
        config['ProgramArguments'] += ['--mode', 'cloud']
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


def _led(item):
    return "#{:02X}{:02X}{:02X}FF".format(*(item.accent if item.level == "info" else status_color(item.level, item.accent)))


def _primary(item):
    try:
        item.primary()
        LOG.info("Handled %s", item.id)
        return True
    except Exception as error:  # The action reports through the log only.
        LOG.warning("Action on %s failed: %s", item.id, (str(error).splitlines() or [type(error).__name__])[-1][:120])
        return False


def watch(args):
    if getattr(args, "mode", "standalone") == "cloud":
        from .cloud_watch import watch as cloud_watch
        return cloud_watch(args, RUNTIME, REPO)
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
    reduced = getattr(args, 'reduced_motion', False)
    motion = MotionDirector(client, reduced=reduced)
    view = ViewMode(RUNTIME / "view.json")
    standby_timer = StandbyTimer()
    monitor = configured_input_monitor(RUNTIME)
    last_input_status = 0
    aircraft = configured_checker(RUNTIME, REPO)
    notifier_config = read_notifier_config(RUNTIME)
    queue = NotificationQueue(**display_settings(notifier_config))
    poller = None
    sources = notifier_sources(notifier_config, RUNTIME, inbox=INBOX,
                               refresh=lambda name: poller.refresh(name))
    if aircraft:
        sources.append(aircraft_source(aircraft))
    poller = Poller(sources, queue, **({"spawn": SPAWN} if SPAWN else {}))
    notice = NotificationPresenter(client, reduced=reduced) if sources else None
    lease = DisplayLease(client)
    action_results = SimpleQueue()
    pending_actions = set()
    lease_renew_at = 0
    shared_paused = False
    alert_retry = 0
    dismiss_notice = False
    device_retry_at = 0
    try:
        monitor.start()
        poller.start()
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
            while True:
                try:
                    item_id, succeeded = action_results.get_nowait()
                except Empty:
                    break
                pending_actions.discard(item_id)
                if succeeded:
                    queue.dismiss(item_id)
            task = registry.select(now)
            turns = registry.active_turns(now)
            known_turns = registry.known_turns()
            was_calendar = view.calendar
            if notice:
                poller.run_due()
            shown = notice.current if notice and notice.active else None
            if monitor.pop_start_pressed():
                # The visible notice may be stale after another host takes over.
                try:
                    other = lease.foreign(fresh=True)
                except AuthError:
                    LOG.error("Cannot verify display ownership; check Keychain before resuming.")
                    return 0
                except APIError:
                    LOG.warning("Cannot verify display ownership; ignored Start/Pause.")
                    device_retry_at = time.monotonic() + backoff
                else:
                    if other:
                        if notice and notice.active:
                            notice.abandon()
                        motion.invalidate()
                        owned = False
                        shared_paused = True
                    elif shown and shown.level == "urgent" and shown.primary:
                        if shown.id not in pending_actions:
                            pending_actions.add(shown.id)
                            _spawn(lambda item=shown: action_results.put((item.id, _primary(item))))
                    else:
                        view.dismiss(known_turns)
                        queue.dismiss_all_except_urgent()
                        dismiss_notice = bool(shown and shown.level != "urgent")
                        LOG.info("View: calendar")
                next_draw = min(next_draw, now)
            allowed = view.allows(turns, known_turns=known_turns)
            standby = task is None or task.state in {"done", "stopped"}
            noticing = bool(notice and notice.active)
            if not allowed or not standby or noticing:
                standby_timer.reset()
            elif standby_timer.expired(time.monotonic()):
                view.dismiss(known_turns)
                allowed = False
                next_draw = min(next_draw, now)
                LOG.info("View: calendar (standby 10s)")
            if was_calendar != view.calendar:
                next_draw = min(next_draw, now)
                if not view.calendar: LOG.info("View: agent")
            if now-last_input_status >= 5:
                monitor.write_status(RUNTIME / "input-status.json")
                if aircraft:
                    active = bool(noticing and notice.current.app == "adsbao")
                    try: aircraft.write_status(active=active)
                    except OSError: LOG.warning("Could not save aircraft diagnostics.")
                last_input_status = now
            top = queue.current()[0] if notice else None
            signature = (task.session_id, task.turn_id, task.state) if task else None
            if signature != last_state:
                LOG.info("State: %s", task.state if task else "idle")
                last_state = signature
                next_draw = min(next_draw, now)
            waiting = top is not None and not noticing and time.monotonic() >= alert_retry
            needs_display = now >= next_draw or motion.due or noticing or waiting or dismiss_notice
            if needs_display and time.monotonic() >= device_retry_at:
                try:
                    if waiting and not lease.acquire(top.level):
                        waiting = False
                        alert_retry = time.monotonic() + 3
                    if waiting:
                        if top.level == "urgent" and lease.foreign() is None and shared_paused:
                            client.clear()
                        if notice.start(top, led=_led(top)):
                            lease_renew_at = time.monotonic() + 5
                            owned = True
                            motion.invalidate()
                            standby_timer.reset()
                            queue.mark_shown(top.id)
                            poller.shown(top)
                            LOG.info("Notice: %s", top.id)
                        else:
                            lease.release()
                        alert_retry = time.monotonic() + 5
                    if notice and notice.active and time.monotonic() >= lease_renew_at:
                        lease_renew_at = time.monotonic() + 5
                        if not lease.renew(notice.current.level):
                            LOG.info("Display taken by another host; %s waits.", notice.current.id)
                            notice.abandon()
                            motion.invalidate()
                    if notice and notice.active:
                        if dismiss_notice or top is None or top.id != notice.current.id:
                            notice.dismiss()
                        current = notice.current
                        if notice.advance():
                            lease.release()
                            motion.invalidate()
                            next_draw = now
                            if not allowed and queue.current()[0] is None:
                                client.clear()
                                owned = False
                        elif current:
                            queue.mark_shown(current.id)
                    dismiss_notice = False
                    foreign = lease.foreign() if lease and not (notice and notice.active) else None
                    if foreign:
                        owned = False
                        if not shared_paused:
                            LOG.info("Another host shows a notification; agent view waits.")
                            motion.invalidate()
                    elif shared_paused and not foreign:
                        next_draw = now
                    shared_paused = bool(foreign)
                    if not (notice and notice.active) and not shared_paused and now >= next_draw:
                        if allowed:
                            sample_tick = time.monotonic()
                            if sample_tick >= next_sample:
                                rates = network.sample()
                                next_sample = sample_tick + 5
                            motion.show(task, now, registry.active_count(now), rates)
                        elif motion.visible:
                            motion.hide()
                        next_draw = now + 5
                    if not (notice and notice.active) and not shared_paused and motion.due:
                        motion.advance()
                    owned = motion.visible or bool(notice and notice.active) or owned
                    backoff = 5
                    device_retry_at = 0
                except AuthError:
                    LOG.error("Authentication stopped the observer. Check Keychain and reinstall to resume.")
                    return 0  # No automatic authentication retry storm in launchd.
                except (ConnectionError, APIError):
                    owned = motion.visible or bool(notice and notice.active) or owned
                    motion.cancel()
                    LOG.warning("Device unavailable; retry in %s seconds.", backoff)
                    device_retry_at = time.monotonic() + backoff
                    next_draw = now + backoff
                    backoff = min(backoff * 2, 60)
            if allowed and standby and motion.standby_visible and not (notice and notice.active):
                standby_timer.shown(time.monotonic())
            time.sleep(0.05 if motion.pending or (notice and notice.active) else 0.25)
    finally:
        poller.stop()
        monitor.stop()
        monitor.write_status(RUNTIME / "input-status.json")
        if owned:
            try:
                if not lease.foreign(fresh=True):
                    client.clear()
            except APIError:
                pass  # Unknown ownership cannot authorize a namespace clear.
        # Keep our lease until cleanup ends so a new holder cannot race a clear.
        lease.release()
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


def notify_demo(args):
    """Play every sample notification once; stop the observer first."""
    from busybar_apps.samples import samples
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (RUNTIME / "watch.lock").open("a")
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError("Stop the observer before the notification demo; reinstall it afterward.") from None
    client = BusyAPI(read_token())
    presenter = NotificationPresenter(client, reduced=args.reduced_motion)
    try:
        for item in samples():
            if args.only and item.app not in args.only:
                continue
            print(item.app, item.title)
            if not presenter.start(item, demo=True, led=_led(item)):
                print("Device focus mode suppressed the demo.")
                return 0
            end = time.monotonic() + args.seconds
            while presenter.active:
                if time.monotonic() >= end:
                    presenter.dismiss()
                presenter.advance()
                time.sleep(.05)
    finally:
        client.clear()
        lock.close()
    return 0


def capture(args):
    client = BusyAPI(read_token())
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    for index in (0, 1):
        image = decode_frame(client.frame(index), index)
        image.save(out / ("device-front.png" if index == 0 else "device-back.png"))
    print("Device framebuffers saved to", out)


def _fallback_seconds(value):
    from busybar_shared.cloud import validated_fallback
    try: return validated_fallback(int(value))
    except ValueError: raise argparse.ArgumentTypeError('Use whole seconds from 1 to 300.') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    observe = sub.add_parser("watch", help="Watch local Codex lifecycle events")
    observe.add_argument("--mode", choices=("standalone", "cloud"), default="standalone")
    observe.add_argument("--dot-thread", action="append", default=[], help="Explicit dots identity override; never fabricates status")
    observe.add_argument("--reduced-motion", action="store_true", help="Use static lights and direct display changes")
    setup = sub.add_parser('install')
    setup.add_argument('--mode', choices=('standalone', 'cloud'), default='standalone')
    setup.add_argument('--reduced-motion', action='store_true', help='Install the service without motion effects')
    status_parser = sub.add_parser("status")
    status_parser.add_argument("--mode", choices=("standalone", "cloud"), default="standalone")
    cloud_parser = sub.add_parser("cloud-setup", help="Validate a scoped publisher credential and store it in Keychain")
    cloud_parser.add_argument("--url", required=True)
    cloud_parser.add_argument("--role", required=True, choices=("agent", "notifier"))
    cloud_parser.add_argument("--instance")
    cloud_parser.add_argument("--fallback-seconds",type=_fallback_seconds,default=10,metavar="1..300",
                              help="Local urgent fallback delay in seconds (default: 10)")
    for name in ('cloud-enroll', 'cloud-migrate'):
        command = sub.add_parser(name, help='Enroll this computer using a one-use ticket or its existing publisher proofs')
        command.add_argument('--url', required=True)
    command = sub.add_parser('cloud-register', help='Register one explicit service for a local source')
    command.add_argument('alias')
    command.add_argument('--name')
    command.add_argument('--template', choices=('agent', 'notifier', 'custom'))
    command.add_argument('--source', help='Local source name or app routed to this service')
    sub.add_parser('cloud-pair', help='Issue a five-minute code to pair a monitoring browser with this computer')
    for name in ("uninstall", "clear", "token-set", "input-wifi"):
        sub.add_parser(name)
    for name in ("preview", "capture"):
        command = sub.add_parser(name)
        command.add_argument("--output", default=".local/"+name)
    command = sub.add_parser("demo", help="Show a finite, explicitly labeled demo")
    command.add_argument("--source", choices=sorted(profiles.sources()), default="chatgpt")
    command.add_argument("--state", choices=("working", "waiting", "done", "error", "stopped"), default="working")
    command.add_argument("--seconds", type=int, choices=range(1,61), default=5, metavar="1..60")
    command=sub.add_parser('motion-demo',help='Show finite DEMO transitions with synthetic clock and rates')
    command.add_argument('--seconds',type=int,choices=range(6,31),default=18,metavar='6..30')
    command.add_argument('--reduced-motion',action='store_true')
    command = sub.add_parser("emit", help="Emit a real lifecycle state from an external tool")
    command.add_argument("state", choices=("working", "waiting", "done", "error", "stopped"))
    command.add_argument("--source", choices=sorted(profiles.sources()), default="chatgpt")
    command.add_argument("--session-id", required=True)
    command.add_argument("--turn-id", required=True)
    command.add_argument("--project", default="AI task")
    command = sub.add_parser("hook", help="Consume structured hook JSON on stdin")
    command.add_argument("--source", choices=sorted(profiles.sources()), default="chatgpt")
    command = sub.add_parser("run", help="Run a command, then show DONE or FAILED as a notification")
    command.add_argument("argv", nargs=argparse.REMAINDER, metavar="-- COMMAND", help="The command and its arguments")
    command = sub.add_parser("notify-demo", help="Play each sample notification once; stop the observer first")
    command.add_argument("--seconds", type=float, default=4)
    command.add_argument("--only", action="append", default=[], help="Limit to one app; repeat for more")
    command.add_argument("--reduced-motion", action="store_true")
    from busybar_apps.adsbao.commands import register as register_aircraft_commands
    register_aircraft_commands(sub)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # HTTP request URLs contain the rounded observation point. Keep library
    # request traces out of the service log; our diagnostics contain no URL.
    logging.getLogger('httpx2').setLevel(logging.WARNING)
    try:
        if args.command in ('cloud-enroll', 'cloud-migrate', 'cloud-register', 'cloud-pair'):
            from . import cloud_registration as registration
            if args.command == 'cloud-enroll':
                value = registration.enroll(RUNTIME, args.url, getpass.getpass('One-use enrollment ticket: '))
                print('Computer enrolled:', value['computerId'])
            elif args.command == 'cloud-migrate':
                value = registration.migrate_legacy(RUNTIME, args.url)
                print('Computer enrolled:', value['computerId'])
            elif args.command == 'cloud-register':
                value = registration.register_service(RUNTIME, args.alias, name=args.name,
                    template=args.template or ('agent' if args.alias == 'codex' else 'notifier'), source=args.source)
                print('Registered service:', value['services'][args.alias]['serviceId'])
            else:
                print(registration.pairing_code(RUNTIME))
                print('Paste this one-use code into the management page within five minutes.')
            return 0
        if args.command.startswith('adsbao-'):
            from busybar_apps.adsbao.commands import run as run_aircraft_command
            return run_aircraft_command(args, RUNTIME, REPO)
        if args.command == "cloud-setup":
            from busybar_shared.cloud import setup as configure_cloud, HELPER
            if not HELPER.exists():
                raise RuntimeError("Build scripts/cloud-keychain.swift first; see docs/cloud-mode.md.")
            configure_cloud(RUNTIME, args.url, args.role, instance=args.instance, secret=getpass.getpass("Publisher credential: "),fallback_seconds=args.fallback_seconds)
            print("Cloud role configured. Run watch --mode cloud when ready.")
            return 0
        if args.command == "watch": return watch(args)
        if args.command == "install": return install(reduced_motion=args.reduced_motion, mode=args.mode)
        if args.command == "uninstall": return uninstall()
        if args.command == "preview": return preview(args)
        if args.command == "capture": return capture(args)
        if args.command == "demo": return demo(args)
        if args.command == 'motion-demo': return motion_demo(args)
        if args.command == "notify-demo": return notify_demo(args)
        if args.command == "run":
            from busybar_apps.terminal import run_and_report
            command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            if not command:
                raise ValueError("Give a command after --.")
            return run_and_report(INBOX, command)
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
            if args.mode == "cloud":
                from .cloud_watch import status as cloud_status
                return cloud_status(RUNTIME)
            state = BusyAPI(read_token()).status()
            service = _service("print")
            from busybar_apps.adsbao.checker import read_status as read_aircraft_status
            print(json.dumps({"connected": True, "firmware": state.get("firmware", {}).get("version"),
                              "api": state.get("system", {}).get("api_semver"),
                              "service_loaded": service.returncode == 0,
                              "service_running": "state = running" in service.stdout,
                              "view": "calendar" if ViewMode(RUNTIME / "view.json").calendar else "codex",
                              "adsbao": read_aircraft_status(RUNTIME),
                              "notifier": sorted(k for k, v in read_notifier_config(RUNTIME).items()
                                                 if k in NOTIFIER_APPS and v not in (None, False)),
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
            try:
                payload = json.loads(raw)
                previous = read_event(SPOOL, payload.get("session_id")) if isinstance(payload, dict) else None
                event = hook_event(payload, source=args.source,
                                   previous_turn=previous.get("turn_id") if previous else None)
            except (ValueError, UnicodeError): return 0
            if event: write_event(SPOOL, event)
        return 0
    except (APIError, RuntimeError, OSError, ValueError) as error:
        LOG.error("%s", error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
