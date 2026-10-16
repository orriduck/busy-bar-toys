"""Explicit cloud observer. Local collection continues while the cloud is slow."""
import fcntl
import json
import logging
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
from .cloud_adapter import AgentRenderer, AgentSignals, CloudQueue, RoutedCloudQueue
from .cloud_registration import FILE as COMPUTER_FILE, load_computer

LOG = logging.getLogger('busy-bar')


def configurations(runtime):
    if (Path(runtime)/COMPUTER_FILE).exists():
        computer=load_computer(runtime)
        if computer['phase']!='active': raise CloudError('computer_enrollment_pending')
        values=[]
        for alias,entry in computer['services'].items():
            if entry.get('pending'): continue
            values.append({**entry,'key':alias,'role':'service-'+entry['serviceId'],
                           'url':computer['url'],'computerId':computer['computerId'],
                           'instanceId':computer['instanceId'],'fallbackSeconds':entry.get('fallbackSeconds',10)})
        if not values: raise CloudError('service_registration_required')
        return values
    configs=[]
    for role in ('agent','notifier'):
        if (Path(runtime)/('cloud-'+role+'.json')).exists(): configs.append(load_config(runtime,role))
    if not configs: raise CloudError('setup_required')
    return configs


def producers(runtime):
    clients={}; secrets={}
    for config in configurations(runtime):
        key='computer' if config.get('computerId') else config['role']
        if key not in secrets: secrets[key]=keychain(key)
        http=Transport(config['url'],secrets[key],**({'service_id':config['serviceId']} if key=='computer' else {}))
        clients[config.get('key',config['role'])]=Producer(runtime,config,http)
    return clients


def status(runtime):
    values={}; diagnostics={}; available=False; secrets={}; errors={}
    for config in configurations(runtime):
        role=config.get('key',config['role']); credential_key='computer' if config.get('computerId') else config['role']
        try:
            if credential_key in errors: raise errors[credential_key]
            if credential_key not in secrets:
                try: secrets[credential_key]=keychain(credential_key)
                except CloudError as error:
                    errors[credential_key]=error; raise
            values[role]=Transport(config['url'],secrets[credential_key],**({'service_id':config['serviceId']} if credential_key=='computer' else {})).request('GET','/api/snapshot')
            available=True
        except CloudError as error:
            values[role]={'error':error.code}
        path=Path(runtime)/('cloud-'+config['role']+'-state.json')
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
        agent_client=next((client for key,client in clients.items() if client.config.get('template',key)=='agent'),None)
        agent=None
        if agent_client:
            computer_mode=any(c.config.get('computerId') for c in clients.values())
            routes=load_computer(runtime)['routes'] if computer_mode else {}
            notify_client=next((c for c in clients.values() if c.config['serviceId']==routes.get('agent-notifier')),None) if computer_mode else clients.get('notifier')
            if (notify_client is None or notify_client.config['serviceId']==agent_client.config['serviceId']
                    or notify_client.config.get('template','notifier')!='notifier'):
                raise CloudError('setup_required_agent_notifier')
            agent=AgentSignals(AgentRenderer(agent_client,reduced=reduced),CloudQueue(notify_client,reduced=reduced))
        view=ViewMode(runtime/'cloud-view.json'); known_turns=set(); cleared=set()
        if agent:
            def tombstone(item_id,reason):
                if reason=='cleared': cleared.add(item_id)
            for client in (agent_client, notify_client):
                previous=client.on_tombstone
                def chained(item_id,reason,previous=previous):
                    tombstone(item_id,reason)
                    if previous: previous(item_id,reason)
                client.on_tombstone=chained
        computer_mode=any(client.config.get('computerId') for client in clients.values())
        if computer_mode or 'notifier' in clients:
            sources=notifier_sources(read_config(runtime),runtime,inbox=runtime/'inbox',refresh=lambda name:poller.refresh(name))
            aircraft=configured_checker(runtime,repo)
            if aircraft: sources.append(aircraft_source(aircraft))
            if computer_mode:
                routes=load_computer(runtime)['routes']; source_routes={}; routed=[]
                queues={client.config['serviceId']:CloudQueue(client,reduced=reduced) for client in clients.values()}
                for source in sources:
                    target=routes.get(source.name,routes.get(source.app))
                    if target not in queues:
                        LOG.warning('No registered service for source %s; collection is disabled.',source.name)
                        continue
                    source_routes[source.name]=target; routed.append(source)
                sources=routed; queue=RoutedCloudQueue(queues,source_routes)
            else:
                queue=CloudQueue(clients['notifier'],reduced=reduced)
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
                        agent.show_tasks(registry.visible_tasks(now),now,registry.active_count(now),network.sample()); next_draw=now+5
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
