#!/usr/bin/env python3
"""Build/sign the Core Location app without launching it or requesting access."""
from pathlib import Path
import argparse
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile


def build(repo: Path, output: Path) -> Path:
    if sys.platform != 'darwin':
        raise RuntimeError('The location helper can only be built on macOS.')
    source = repo / 'apps/src/busybar_apps/adsbao/macos'
    metadata = plistlib.loads((source / 'Info.plist').read_bytes())
    if metadata.get('CFBundleIdentifier') != 'app.busybar.location':
        raise RuntimeError('Unexpected location helper application identity.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='busybar-location-', dir=output.parent) as directory:
        app = Path(directory) / 'BusyBarLocation.app'
        executable = app / 'Contents/MacOS/BusyBarLocation'
        executable.parent.mkdir(parents=True)
        shutil.copyfile(source / 'Info.plist', app / 'Contents/Info.plist')
        env = os.environ.copy()
        env['MACOSX_DEPLOYMENT_TARGET'] = '11.0'
        subprocess.run(['xcrun', 'swiftc', '-O', '-framework', 'AppKit', '-framework', 'CoreLocation',
                        str(source / 'BusyBarLocation.swift'), '-o', str(executable)], check=True, env=env)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                        'app.busybar.location', '--requirements',
                        '=designated => identifier "app.busybar.location"', '--timestamp=none', str(app)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True)
        if output.exists():
            shutil.rmtree(output)
        shutil.move(str(app), str(output))
    return output


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=repo / '.venv/BusyBarLocation.app')
    args = parser.parse_args()
    print(build(repo, args.output.resolve()))


if __name__ == '__main__':
    main()
