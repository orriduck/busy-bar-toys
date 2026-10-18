"""Source-neutral occurrence lifetime and native delta publication.

Source adapters own observation and rendering. Producer owns transport and leases.
"""
import copy
import json


class ActivityPublisher:
    def __init__(self, producer, key, *, identity_field='activitySession', withdraw=False):
        self.producer, self.key = producer, key
        self.identity_field, self.withdraw = identity_field, withdraw
        previous = producer.state.records.get(key) or {}
        self.identity = previous.get(identity_field)

    def begin(self, identity):
        # Normalize tuples and lists to the representation saved in JSON.
        identity = json.loads(json.dumps(identity, allow_nan=False))
        if self.identity is not None and identity != self.identity:
            self.hide()
        self.identity = identity

    def publish(self, content, changed=None):
        state = self.producer.state
        with state.lock:
            previous = copy.deepcopy(state.records.get(self.key) or {})
            record = state.recognize(self.key, **{**content, self.identity_field:self.identity})
            if record and changed is not None:
                live = state.records[self.key]
                if live['acked'] and live['version'] > live['acked']:
                    pending = {e['id']:e for e in previous.get('update', [])
                               if previous.get('itemId') == live['itemId']}
                    pending.update({e['id']:copy.deepcopy(e) for e in changed})
                    live['update'] = list(pending.values())
                    state.save()
            return record

    def renew(self):
        state = self.producer.state
        with state.lock:
            record = state.records.get(self.key)
            if record and not record.get('cleared') and not record.get('tombstone'):
                record['lastSourceAt'] = int(self.producer.clock()*1000)
                record['sourceUnknown'] = False
                record.pop('handoverPendingSource', None)
                state.save()

    def unknown(self):
        state = self.producer.state
        with state.lock:
            record = state.records.get(self.key)
            if record and not record.get('cleared') and not record.get('tombstone'):
                record['sourceUnknown'] = True
                # Existing Producer fences pending publication until a fresh
                # source observation; this does not alter its serialization.
                record['handoverPendingSource'] = True
                state.save()

    def hide(self):
        self.producer.state.clear(self.key, withdraw=self.withdraw)
