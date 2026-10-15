import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from busylib.state_stream_proto import state_pb2,input_pb2
from websockets.asyncio.server import serve

from busybar_shared.device_input import InputMonitor, start_pressed, read_input_status
from busybar_shared import device_input
from busybar_shared.api import AuthError


def frame(button=input_pb2.START,action=input_pb2.PRESS):
    state=state_pb2.State(timestamp=1)
    event=state.updates.add().input.button_event
    event.button=button;event.action=action
    return state.SerializeToString()


class InputTests(unittest.TestCase):
    def test_status_write_errors_do_not_interrupt_shutdown_cleanup(self):
        monitor=InputMonitor()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'input-status.json'
            for operation in ('mkdir','replace'):
                with self.subTest(operation=operation), \
                     patch.object(Path,operation,side_effect=OSError('disk unavailable')):
                    try:
                        monitor.write_status(path)
                    except OSError as error:
                        self.fail(f'Optional status writing interrupted cleanup: {error}')
                self.assertEqual(list(Path(directory).iterdir()),[])

    def test_only_start_press_with_proto_default_action_dismisses(self):
        self.assertTrue(start_pressed(frame()))
        for button,action in [(input_pb2.START,input_pb2.RELEASE),
                              (input_pb2.OK,input_pb2.PRESS),
                              (input_pb2.BACK,input_pb2.PRESS)]:
            self.assertFalse(start_pressed(frame(button,action)))
        self.assertFalse(start_pressed(state_pb2.State(timestamp=1).SerializeToString()))
        with self.assertRaises(ValueError): start_pressed(b'\xff')
        with self.assertRaises(ValueError): start_pressed(b'x'*262145)

    def test_stale_status_does_not_claim_a_live_input_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'input-status.json'
            path.write_text(json.dumps({'connected':True,'error':'','timestamp':100}))
            self.assertFalse(read_input_status(path,now=140)['connected'])
            self.assertTrue(read_input_status(path,now=101)['connected'])
            path.write_text('broken')
            self.assertFalse(read_input_status(path,now=101)['connected'])


class InputConfigTests(unittest.TestCase):
    def factory(self):
        factory=getattr(device_input,'configured_input_monitor',None)
        self.assertIsNotNone(factory,'Configured Wi-Fi input must not block the cloud observer')
        return factory

    def test_absent_config_keeps_usb_without_reading_a_local_token(self):
        factory=self.factory()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(device_input,'read_input_token',create=True) as read:
            monitor=factory(Path(directory))
        self.assertTrue(monitor.enabled)
        self.assertEqual(monitor.transport,'usb')
        read.assert_not_called()

    def test_private_wifi_config_loads_token_only_from_keychain(self):
        factory=self.factory()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'input.json').write_text(json.dumps({'addr':'192.168.99.189',
                                                      'device_id':'synthetic-device'}))
            with patch.object(device_input,'read_input_token',return_value='synthetic-secret',
                              create=True) as read:
                monitor=factory(root)
            self.assertTrue(monitor.enabled)
            self.assertEqual(monitor.transport,'wifi')
            self.assertIn('192.168.99.189/api/status/ws?',monitor._url)
            self.assertIn('x-api-token=synthetic-secret',monitor._url)
            self.assertNotIn('synthetic-secret',(root/'input.json').read_text())
            read.assert_called_once_with()

    def test_invalid_config_disables_input_without_reading_credentials_or_connecting(self):
        factory=self.factory()
        invalid=['broken','[]',json.dumps({'addr':'8.8.8.8'}),
                 json.dumps({'addr':'192.168.1.2:wrong'}),
                 json.dumps({'addr':'192.168.1.2','token':'must-not-be-in-config'}),
                 json.dumps({'addr':'192.168.1.2','device_id':[]})]
        for raw in invalid:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                (root/'input.json').write_text(raw)
                with patch.object(device_input,'read_input_token',create=True) as read, \
                     patch.object(threading.Thread,'start') as start:
                    monitor=factory(root)
                    monitor.start()
                    self.assertFalse(monitor.enabled)
                    self.assertEqual(monitor.transport,'wifi')
                    monitor.write_status(root/'status.json')
                    self.assertEqual(read_input_status(root/'status.json')['error'],'protocol')
                read.assert_not_called()
                start.assert_not_called()

    def test_keychain_failure_is_disabled_auth_and_diagnostics_include_transport(self):
        factory=self.factory()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'input.json').write_text(json.dumps({'addr':'192.168.1.2'}))
            with patch.object(device_input,'read_input_token',side_effect=AuthError('unavailable'),
                              create=True) as read, \
                 patch.object(threading.Thread,'start') as start:
                monitor=factory(root)
                monitor.start()
                monitor.write_status(root/'status.json')
                self.assertFalse(monitor.enabled)
                self.assertEqual(read_input_status(root/'status.json'),
                                 {'connected':False,'error':'auth','transport':'wifi'})
                self.assertNotIn('synthetic-secret',(root/'status.json').read_text())
            read.assert_called_once_with()
            start.assert_not_called()


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_press_arriving_during_empty_pop_remains_pending(self):
        checked=threading.Event()
        release=threading.Event()
        producer_arrived=threading.Event()
        recorded=threading.Event()
        allow_press=asyncio.Event()
        ready=asyncio.Event()

        class PausedEvent(threading.Event):
            def is_set(self):
                result=super().is_set()
                checked.set()
                release.wait(3)
                return result

            def set(self):
                producer_arrived.set()
                super().set()
                recorded.set()

        class ObservedLock:
            def __init__(self): self.lock=threading.Lock()

            def __enter__(self):
                if threading.current_thread().name=='busy-bar-input':
                    producer_arrived.set()
                self.lock.acquire()

            def __exit__(self,*args): self.lock.release()

        async def handler(ws):
            await ws.recv()
            await ws.send(frame(action=input_pb2.RELEASE))
            ready.set()
            await allow_press.wait()
            await ws.send(frame())
            await ws.wait_closed()

        async with serve(handler,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]
            monitor=InputMonitor(addr=f'127.0.0.1:{port}')
            monitor._pressed=PausedEvent()
            monitor._pressed_lock=ObservedLock()
            monitor.start()
            try:
                await asyncio.wait_for(ready.wait(),3)
                consumer=asyncio.create_task(asyncio.to_thread(monitor.pop_start_pressed))
                self.assertTrue(await asyncio.to_thread(checked.wait,3))
                allow_press.set()
                self.assertTrue(await asyncio.to_thread(producer_arrived.wait,3))
                release.set()
                self.assertFalse(await asyncio.wait_for(consumer,3))
                self.assertTrue(await asyncio.to_thread(recorded.wait,3))
                self.assertTrue(monitor.pop_start_pressed())
                self.assertFalse(monitor.pop_start_pressed())
            finally:
                release.set()
                await asyncio.to_thread(monitor.stop)

    async def test_real_local_websocket_handshake_filtering_and_shutdown(self):
        sent=asyncio.Event()
        allow_press=asyncio.Event()
        async def handler(ws):
            self.assertEqual(json.loads(await ws.recv()),{'enable':True})
            await ws.send(frame(action=input_pb2.RELEASE))
            sent.set()
            await allow_press.wait()
            await ws.send(frame())
            await ws.wait_closed()
        async with serve(handler,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]
            monitor=InputMonitor(addr=f'127.0.0.1:{port}')
            monitor.start()
            try:
                await asyncio.wait_for(sent.wait(),3)
                for _ in range(50):
                    if monitor.connected: break
                    await asyncio.sleep(.02)
                self.assertTrue(monitor.connected)
                self.assertFalse(monitor.pop_start_pressed())
                allow_press.set()
                for _ in range(50):
                    if monitor.pop_start_pressed(): break
                    await asyncio.sleep(.02)
                else:self.fail('START PRESS was not delivered')
                with tempfile.TemporaryDirectory() as directory:
                    path=Path(directory)/'input-status.json'
                    monitor.write_status(path)
                    self.assertTrue(read_input_status(path)['connected'])
                    self.assertEqual(path.stat().st_mode & 0o777,0o600)
            finally:
                # Keep the server event loop free while the thread closes.
                await asyncio.to_thread(monitor.stop)
            self.assertFalse(monitor.connected)
            self.assertFalse(monitor.is_alive())
