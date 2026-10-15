"""Explicit cloud observer. Local collection continues while the cloud is slow."""
import fcntl
import json
import signal
import time
from pathlib import Path

from busybar_shared.cloud import CloudError, Producer, Transport, State, keychain, load_config
from busybar_agents.network import NetworkSampler
from busybar_agents.view import ViewMode
from busybar_shared.device_input import configured_input_monitor, InputMonitor
from busybar_shared.preview import PreviewBridge
from busybar_apps.codex.records import CodexTaskRegistry, RolloutWatcher
from busybar_apps.dots.orbit import load_dot_thread_ids
from busybar_agents.runtime import read_spool
from busybar_apps import notifier_sources
from busybar_apps.adsbao.checker import configured_checker
from busybar_apps.adsbao.source import aircraft_source
from busybar_notifier.source import Poller
from busybar_notifier.config import read_config
from .cloud_adapter import AgentRenderer, CloudQueue


def configurations(runtime):
    configs=[]
    for role in ('agent','notifier'):
        if (Path(runtime)/('cloud-'+role+'.json')).exists(): configs.append(load_config(runtime,role))
    if not configs: raise CloudError('setup_required')
    return configs


def producers(runtime):
    return {config['role']:Producer(runtime,config,Transport(config['url'],keychain(config['role'])))
            for config in configurations(runtime)}


def status(runtime):
    values={}; diagnostics={}; available=False
    for config in configurations(runtime):
        role=config['role']
        try:
            values[role]=Transport(config['url'],keychain(role)).request('GET','/api/snapshot')
            available=True
        except CloudError as error:
            values[role]={'error':error.code}
        path=Path(runtime)/('cloud-'+role+'-state.json')
        if path.exists():
            state=State(path)
            diagnostics[role]={'notification':state.data.get('notificationStatus'),
                               'notificationResults':state.data.get('notificationResults',[])}
    print(json.dumps({'mode':'cloud','services':values,'localDiagnostics':diagnostics},indent=2))
    return 0 if available else 1


def watch(args,runtime,repo):
    runtime=Path(runtime); runtime.mkdir(mode=0o700,parents=True,exist_ok=True); runtime.chmod(0o700)
    lock=(runtime/'watch.lock').open('a')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close(); raise RuntimeError('The BUSY Bar observer is already running.') from None
    clients={}; poller=None; monitor=None; preview=None; stopping=False
    def stop(*_):
        nonlocal stopping
        stopping=True
    old_signals={sig:signal.signal(sig,stop) for sig in (signal.SIGTERM,signal.SIGINT)}
    try:
        clients=producers(runtime)
        registry=CodexTaskRegistry(); dot_ids=set(getattr(args,'dot_thread',[]))
        watcher=RolloutWatcher(Path.home()/'.codex/sessions',registry,
                              load_dot_thread_ids(Path.home()/'.codex/.codex-global-state.json')|dot_ids)
        network=NetworkSampler(); reduced=getattr(args,'reduced_motion',False)
        agent=AgentRenderer(clients['agent'],reduced=reduced) if 'agent' in clients else None
        view=ViewMode(runtime/'cloud-view.json'); known_turns=set(); cleared=set()
        if agent:
            def tombstone(item_id,reason):
                if reason=='cleared': cleared.add(item_id)
            clients['agent'].on_tombstone=tombstone
        if 'notifier' in clients:
            queue=CloudQueue(clients['notifier'],reduced=reduced)
            sources=notifier_sources(read_config(runtime),runtime,inbox=runtime/'inbox',refresh=lambda name:poller.refresh(name))
            aircraft=configured_checker(runtime,repo)
            if aircraft: sources.append(aircraft_source(aircraft))
            poller=Poller(sources,queue); queue.on_shown=poller.shown; poller.start()
        # Cloud input uses only explicitly configured Wi-Fi. The monitor reads
        # device input; button actions always go through /api/input.
        input_client=None
        for client in clients.values():
            # Snapshot authorization is refreshed in the background. Selection
            # never determines the designated input listener identity.
            if input_client is None: input_client=client
        monitor=configured_input_monitor(runtime) if (runtime/'input.json').exists() else InputMonitor(enabled=False)
        monitor.start()
        for client in clients.values(): client.start()
        preview=PreviewBridge(runtime,clients); preview.start()
        last_scan=last_dot=next_draw=next_status=0; seen={}
        while not stopping:
            now=time.time()
            if now-last_dot>=60:
                watcher.dot_thread_ids=load_dot_thread_ids(Path.home()/'.codex/.codex-global-state.json')|dot_ids; last_dot=now
            if now-last_scan>=1:
                watcher.poll(now); last_scan=now
            for event in read_spool(now=now):
                key=event.get('session_id',''); stamp=event.get('timestamp')
                if seen.get(key)!=stamp:
                    if key in watcher.dot_thread_ids: event['source']='dots'
                    registry.ingest(event,now); seen[key]=stamp
            if poller: poller.run_due()
            known_turns=registry.known_turns()
            if cleared:
                view.dismiss(known_turns); cleared.clear()
            # Only an explicitly allowInput service can forward local presses.
            if monitor.pop_start_pressed():
                for client in clients.values():
                    service=next((s for s in client.snapshot.get('services',[]) if s.get('id')==client.config['serviceId']),{})
                    if service.get('config',{}).get('allowInput') is True:
                        client.input(); break
            if agent:
                if view.allows(registry.active_turns(now),known_turns=known_turns):
                    if now>=next_draw:
                        agent.show(registry.select(now),now,registry.active_count(now),network.sample()); next_draw=now+5
                    if agent.due: agent.advance()
                else: agent.hide()
            if now>=next_status:
                monitor.write_status(runtime/'input-status.json'); next_status=now+5
            time.sleep(.05 if agent and agent.pending else .25)
    finally:
        if preview: preview.stop()
        if poller: poller.stop()
        if monitor: monitor.stop(); monitor.write_status(runtime/'input-status.json')
        for client in clients.values(): client.stop()
        for sig,handler in old_signals.items(): signal.signal(sig,handler)
        lock.close()
    return 0
