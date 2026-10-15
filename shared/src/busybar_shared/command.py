"""Run a local command-line tool with a timeout; report only a short error."""
import json
import subprocess


class CommandError(RuntimeError):
    pass


def run(args, *, timeout=60, check=True):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise CommandError(f"{args[0]} is not installed.") from None
    except subprocess.TimeoutExpired:
        raise CommandError(f"{args[0]} did not finish in {timeout} seconds.") from None
    if check and result.returncode:
        lines = [line for line in (result.stderr or result.stdout).splitlines() if line.strip()]
        raise CommandError(lines[-1][:160] if lines else f"{args[0]} exited with code {result.returncode}.")
    return result


def run_json(args, *, timeout=60):
    return json.loads(run(args, timeout=timeout).stdout)
