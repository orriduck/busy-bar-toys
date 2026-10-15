#!/usr/bin/env python3
"""Run the checker and shared suites from any working directory."""
from pathlib import Path
import unittest

root=Path(__file__).resolve().parents[1]
suite=unittest.TestSuite()
for directory in ('shared','codex-checker','adsbao-checker'):
    tests=root/directory/'tests'
    if tests.exists():
        suite.addTests(unittest.TestLoader().discover(str(tests)))
result=unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(not result.wasSuccessful())
