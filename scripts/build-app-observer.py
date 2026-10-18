#!/usr/bin/env python3
"""Build the read-only local AppKit sampler. Do not launch any game."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def build(repo, output):
    if sys.platform != 'darwin': raise RuntimeError('The app observer requires macOS.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='busybar-apps-', dir=output.parent) as folder:
        executable = Path(folder)/'busy-running-apps'
        env = {**os.environ, 'MACOSX_DEPLOYMENT_TARGET':'11.0'}
        subprocess.run(['xcrun','swiftc','-O','-framework','AppKit',
                        str(repo/'shared/src/busybar_shared/assets/RunningApps.swift'),
                        '-o',str(executable)], check=True, env=env)
        executable.chmod(0o755)
        executable.replace(output)
    return output


if __name__ == '__main__':
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=repo/'.venv/bin/busy-running-apps')
    args = parser.parse_args()
    print(build(repo, args.output.resolve()))
