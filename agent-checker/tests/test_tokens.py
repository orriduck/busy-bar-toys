import dataclasses
import unittest
from types import SimpleNamespace
from busybar_agents.tokens import TokenUsage, compact_tokens, task_usage


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

    def test_reported_reply_throughput_is_shown_and_held(self):
        task=SimpleNamespace(session_id='s',state='working',token_usage=TokenUsage(9999,9999),token_rate=TokenUsage(27,25))
        self.assertEqual(task_usage(task),TokenUsage(27,25))
        task.state='done'
        self.assertEqual(task_usage(task),TokenUsage(27,25),'A finished turn keeps its last reply')

    def test_unknown_without_reply_boundaries_or_after_the_session_ends(self):
        totals_only=SimpleNamespace(session_id='codex',state='working',token_usage=TokenUsage(5000,100),token_rate=None)
        self.assertIsNone(task_usage(totals_only),'Totals without reply boundaries are never turned into a rate')
        for state in ('stopped','unknown'):
            ended=SimpleNamespace(session_id='s',state=state,token_usage=None,token_rate=TokenUsage(27,25))
            self.assertIsNone(task_usage(ended),state)
        self.assertIsNone(task_usage(None))
        self.assertEqual(task_usage(None,TokenUsage(1,2)),TokenUsage(1,2),'Explicit demo rates win')
