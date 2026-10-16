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

    def meter(self):
        clock=[0.0]
        return clock, TokenRateMeter(window=10,clock=lambda:clock[0])

    def test_rate_is_unknown_during_warm_up_then_covers_the_last_window(self):
        clock,meter=self.meter()
        meter.observe('s',TokenUsage(5000,100))
        self.assertIsNone(meter.rate('s'),'One sample is not a rate')
        for t in range(1,21):
            clock[0]=t; meter.observe('s',TokenUsage(5000+100*t,100+10*t))
            if t==4: self.assertEqual(meter.rate('s'),TokenUsage(100,10),'Warm-up covers the observed span')
        self.assertEqual(meter.rate('s'),TokenUsage(100,10))
        for t in range(21,32):
            clock[0]=t; meter.observe('s',TokenUsage(7000,300))
        self.assertEqual(meter.rate('s'),TokenUsage(0,0),'An idle full window is zero')

    def test_long_unobserved_gap_restarts_instead_of_averaging(self):
        clock,meter=self.meter()
        meter.observe('s',TokenUsage(0,0))
        clock[0]=100
        self.assertIsNone(meter.rate('s'),'A stale sample is unknown')
        meter.observe('s',TokenUsage(1000,100))
        self.assertIsNone(meter.rate('s'),'The 100-second delta is never shown')
        clock[0]=102; meter.observe('s',TokenUsage(1200,140))
        self.assertEqual(meter.rate('s'),TokenUsage(100,20))

    def test_unavailable_and_decreased_totals_reset_without_a_fabricated_delta(self):
        clock,meter=self.meter()
        meter.observe('s',TokenUsage(100,10)); clock[0]=1; meter.observe('s',TokenUsage(200,20))
        meter.observe('s',None)
        self.assertIsNone(meter.rate('s'))
        clock[0]=2; meter.observe('s',TokenUsage(90000,9000))
        self.assertIsNone(meter.rate('s'),'Recovery starts a new warm-up')
        clock[0]=3; meter.observe('s',TokenUsage(10,1))
        clock[0]=4; meter.observe('s',TokenUsage(40,4))
        self.assertEqual(meter.rate('s'),TokenUsage(30,3),'A decrease restarts the samples')

    def test_sessions_are_isolated_and_retained_only_while_live(self):
        clock,meter=self.meter()
        meter.observe('a',TokenUsage(0,0)); meter.observe('b',TokenUsage(0,0))
        clock[0]=2; meter.observe('a',TokenUsage(200,20)); meter.observe('b',TokenUsage(0,0))
        self.assertEqual((meter.rate('a'),meter.rate('b')),(TokenUsage(100,10),TokenUsage(0,0)))
        meter.retain({'b'})
        self.assertIsNone(meter.rate('a'))
