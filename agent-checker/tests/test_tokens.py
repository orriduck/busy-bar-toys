import dataclasses
import unittest
from busybar_agents.tokens import TokenUsage, compact_tokens


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
