"""Service-queue reconciliation and delivery evidence, independent of transport.

The injected durable State retains its existing schema. Connections submit
snapshots; only this owner applies queue evidence or advances acknowledgements.
A disconnect has no domain meaning and therefore no queue-reset method exists.
"""
import copy
import json
import math
import threading
import time


class ServiceQueue:
    def __init__(self, state, config, guard, *, clock, error_type):
        self.state=state; self.config=config; self.guard=guard
        self.clock=clock; self.error_type=error_type
        self.snapshot={}
        self._snapshot_lock=threading.Lock()
        self._accept_lock=threading.RLock()
        self._snapshot_received_at=None; self._snapshot_server_now=None
        self.on_admitted=None; self.on_tombstone=None

    def read_snapshot(self):
        with self._snapshot_lock:return copy.deepcopy(self.snapshot)

    def accept(self,snapshot):
        # Queue reconciliation is one ordered owner even with concurrent SSE,
        # poll and publish responses. Transport lanes never reset this state.
        with self._accept_lock:self._accept_snapshot(snapshot)

    def _accept_snapshot(self,snapshot):
        if not isinstance(snapshot,dict) or snapshot.get('protocol')!=1: raise self.error_type('invalid_snapshot')
        received_at=time.monotonic()
        if any(s.get('id')!=self.config['serviceId'] for s in snapshot.get('services',[])):
            raise self.error_type('scope_violation')
        with self._snapshot_lock:
            if snapshot.get('revision',0)<self.snapshot.get('revision',-1): return
            self.snapshot=copy.deepcopy(snapshot)
        if any(i.get('serviceId',self.config['serviceId'])!=self.config['serviceId'] for i in snapshot.get('items',[])):
            raise self.error_type('scope_violation')
        self.guard.snapshot(snapshot)
        # Receipt history grows over the enrollment lifetime. Index our exact
        # scoped keys once instead of serializing every record for every receipt
        # on each SSE, poll and heartbeat snapshot. Keep durable reconciliation
        # and callbacks in State.tombstone, including repeated fallback updates.
        with self.state.lock:
            receipt_ids={}
            for local_key,rec in self.state.records.items():
                key=json.dumps([self.config['serviceId'],self.config['instanceId'],rec['itemId']],separators=(',',':'))
                entry=receipt_ids.setdefault(key,(rec['itemId'],[]))
                entry[1].append(local_key)
        for tomb in snapshot.get('tombstones',[]):
            key=tomb.get('itemKey')
            match=receipt_ids.get(key) if isinstance(key,str) else None
            if match is not None:
                item_id,record_keys=match
                changed=self.state.tombstone(item_id,tomb.get('reason','ended'),record_keys=record_keys)
                if changed and self.on_tombstone: self.on_tombstone(item_id,tomb.get('reason'))
        now=self.clock()*1000
        display=snapshot.get('displaying') or {}
        for item in snapshot.get('items',[]):
            proof=item.get('coverageProof') or {}; controller=proof.get('controller') or {}
            with self.state.lock:
                record=next((r for r in self.state.records.values() if r['itemId']==item.get('itemId')),None)
            admitted=(record is not None and record['version']==item.get('version')==proof.get('version')
                      and snapshot.get('health',{}).get('status')=='healthy'
                      and proof.get('revision')==snapshot.get('revision')
                      and proof.get('itemKey')==item.get('itemKey')
                      and controller.get('itemKey')==display.get('itemKey')
                      and controller.get('generation')==display.get('generation')==snapshot.get('generation')
                      and now<proof.get('validUntil',0)<=display.get('confirmedValidUntil',0))
            if admitted and item.get('instanceId')==self.config['instanceId']:
                ident=item.get('itemId')
                if self.on_admitted:
                    with self.state.lock:
                        live=next((r for r in self.state.records.values() if r['itemId']==ident),None)
                        if live is None or live.get('admitted'): continue
                        live['admitted']=True; self.state.save()
                    if not self.on_admitted(ident):
                        with self.state.lock:
                            live=next((r for r in self.state.records.values() if r['itemId']==ident),None)
                            if live: live['admitted']=False; self.state.save()
        server_now=snapshot.get('serverNow')
        if type(server_now)in(int,float) and math.isfinite(server_now):
            with self._snapshot_lock:
                if self._snapshot_server_now is None or server_now>self._snapshot_server_now:
                    self._snapshot_server_now=server_now;self._snapshot_received_at=received_at

    def snapshot_due(self):
        with self._snapshot_lock:received_at=self._snapshot_received_at
        return received_at is None or not 0<=time.monotonic()-received_at<5

    def recover_expired_publish(self, rec):
        """Return the existing/recovered record, or None when evidence is lacking."""
        with self._accept_lock:
            with self._snapshot_lock:
                remote=next((i for i in self.snapshot.get('items',[]) if i.get('itemId')==rec['itemId']),None)
                received_at=self._snapshot_received_at
                fresh_snapshot=received_at is not None and 0<=time.monotonic()-received_at<5
            if remote is not None:return rec
            if not fresh_snapshot:return None
            if rec.get('sourceUnknown') or rec['lastSourceAt']+45000<=self.clock()*1000:return None
            with self.state.lock:
                live=next((r for r in self.state.records.values() if r['itemId']==rec['itemId']),None)
                if (live is None or live['version']!=rec['version']
                        or live.get('tombstone') or live.get('cleared')):return None
                live['version']+=1; live.pop('publishBody',None); live.pop('updateBody',None)
                self.state.save()
                return copy.deepcopy(live)

    def acknowledge(self, item_id, version):
        """A successful business response, never connection health, advances ack."""
        with self.state.lock:
            live=next((r for r in self.state.records.values() if r['itemId']==item_id),None)
            if live:
                live['acked']=max(live['acked'],version)
                if live['version']==version:live.pop('update',None)
                self.state.save()
