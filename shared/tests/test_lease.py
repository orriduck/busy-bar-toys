import json
import unittest

from busybar_shared.api import APIError
from busybar_shared.lease import TTL, DisplayLease


class Storage:
    def __init__(self):
        self.files = {}
        self.reads = 0

    def read_file(self, path):
        self.reads += 1
        if path not in self.files:
            raise APIError("BUSY request failed (HTTP 400).")
        return self.files[path]

    def write_file(self, path, data):
        self.files[path] = data


class LeaseTest(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.device = Storage()
        self.home = DisplayLease(self.device, host="home", clock=lambda: self.now[0])
        self.work = DisplayLease(self.device, host="work", clock=lambda: self.now[0])

    def test_one_host_at_a_time_and_expiry(self):
        self.assertTrue(self.home.acquire("info"))
        self.assertFalse(self.work.acquire("attention"))
        self.assertEqual(self.work.foreign(fresh=True)["host"], "home")
        self.now[0] += TTL + 1
        self.assertIsNone(self.work.foreign(fresh=True))
        self.assertTrue(self.work.acquire("info"))

    def test_urgent_takes_the_display_and_the_holder_notices(self):
        self.assertTrue(self.home.acquire("info"))
        self.assertTrue(self.work.acquire("urgent"))
        self.assertFalse(self.home.renew("info"))
        self.assertFalse(self.home.held)

    def test_release_frees_the_display_only_for_the_holder(self):
        self.home.acquire("info")
        self.work.release()
        self.assertIsNotNone(self.work.foreign(fresh=True))
        self.home.release()
        self.assertIsNone(self.work.foreign(fresh=True))
        self.assertEqual(json.loads(self.device.files["/ext/user_assets/ai-status/display-lease.json"])["until"], 0)

    def test_missing_or_corrupt_lease_means_free(self):
        self.assertIsNone(self.work.foreign(fresh=True))
        self.device.files["/ext/user_assets/ai-status/display-lease.json"] = b"{"
        self.assertIsNone(self.work.foreign(fresh=True))

    def test_reads_are_cached_between_display_decisions(self):
        self.home.acquire("info")
        reads = self.device.reads
        for _ in range(5):
            self.work.foreign()
        self.assertEqual(self.device.reads, reads + 1)


if __name__ == "__main__":
    unittest.main()
