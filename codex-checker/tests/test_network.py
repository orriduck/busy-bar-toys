import unittest
from unittest.mock import Mock

from busybar_status.network import NetworkSampler, parse_counters, compact_rate


class NetworkTests(unittest.TestCase):
    def test_link_counters_are_not_doubled_by_ip_rows(self):
        text = '''Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
 en0 1500 <Link#14> aa:bb 10 0 8000 5 0 2000 0
 en0 1500 192.0.2 192.0.2.1 10 - 8000 5 - 2000 -'''
        self.assertEqual(parse_counters(text, 'en0'), ('en0', 8000, 2000))
        self.assertEqual(parse_counters('utun1 1500 <Link#8> 10 0 400 5 0 100 0', 'utun1'),
                         ('utun1', 400, 100))

    def test_rates_use_byte_deltas_monotonic_time_and_correct_directions(self):
        sampler = NetworkSampler(reader=Mock(side_effect=[('en0',100,200),('en0',1100,450)]),
                                 clock=Mock(side_effect=[10,12.5]))
        self.assertIsNone(sampler.sample())
        rates = sampler.sample()
        self.assertEqual((rates.upload,rates.download,rates.interface), (100,400,'en0'))

    def test_changes_resets_errors_and_invalid_elapsed_rebaseline(self):
        samples=[('en0',100,100),('en1',9000,9000),('en1',100,100),
                 OSError('unavailable'),('en1',200,200),('en1',300,300),('en1',400,500)]
        sampler=NetworkSampler(reader=Mock(side_effect=samples),
                               clock=Mock(side_effect=[1,2,3,4,5,5,6]))
        for _ in range(6): self.assertIsNone(sampler.sample())
        rates=sampler.sample()
        self.assertEqual((rates.upload,rates.download),(200,100))

    def test_compact_rates_fit_the_speed_row_including_unit_boundaries(self):
        self.assertEqual([compact_rate(n) for n in (None,0,850,1536,1024**2,1024**3)],
                         ['--','0B','850B','1.5K','1.0M','1.0G'])
        for n in (1023,1023.9,1024*999.99,1024**2-1,10**20):
            self.assertLessEqual(len(compact_rate(n)),4)


if __name__=='__main__': unittest.main()
