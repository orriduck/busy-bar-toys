import dataclasses
import unittest
from busybar_agents.tokens import TokenRateMeter, TokenUsage, compact_tokens


class TokenTests(unittest.TestCase):
    def test_counts_are_immutable_nonnegative_integers(self):
        usage=TokenUsage(0,123)
        with self.assertRaises(dataclasses.FrozenInstanceError): usage.input_tokens=4
        for value in (True,False,-1,1.0,None,'3'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError): TokenUsage(value,0)
                with self.assertRaises(ValueError): TokenUsage(0,value)
        for value in (True,False,-1,1.0,'3'):
            with self.assertRaises(ValueError): compact_tokens(value)

    def test_decimal_boundaries_never_exceed_three_glyphs(self):
        for value,label in [(None,'--'),(0,'0'),(999,'999'),(1000,'1K'),(99999,'99K'),
                            (100000,'.1M'),(999999,'.9M'),(1000000,'1M'),
                            (100000000,'.1G'),(1000000000,'1G'),(10**15,'+++')]:
            self.assertEqual(compact_tokens(value),label)
            self.assertLessEqual(len(label),3)

    def test_rate_meter_averages_session_totals_over_the_window(self):
        clock=[0.0]; meter=TokenRateMeter(window=10,clock=lambda:clock[0])
        self.assertEqual(meter.rate('s',TokenUsage(5000,100)),TokenUsage(0,0))
        clock[0]=10
        self.assertEqual(meter.rate('s',TokenUsage(15000,600)),TokenUsage(1000,50))
        clock[0]=25
        self.assertEqual(meter.rate('s',TokenUsage(15000,600)),TokenUsage(0,0),'Idle sessions decay to zero')
        self.assertIsNone(meter.rate('s',None))

    def test_rate_meter_resets_on_counter_decrease_and_keeps_sessions_apart(self):
        clock=[0.0]; meter=TokenRateMeter(window=10,clock=lambda:clock[0])
        meter.rate('a',TokenUsage(100,100)); meter.rate('b',TokenUsage(0,0))
        clock[0]=5
        self.assertEqual(meter.rate('a',TokenUsage(10,10)),TokenUsage(0,0))
        self.assertEqual(meter.rate('b',TokenUsage(500,50)),TokenUsage(100,10))

