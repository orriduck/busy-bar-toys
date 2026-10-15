"""Print recent failed runs of the named flows as JSON. Runs in a Python with Metaflow."""
import json
import sys
from datetime import datetime, timedelta, timezone

from metaflow import Flow, namespace
from metaflow.exception import MetaflowNotFound

RUNS_PER_FLOW = 5


def failed(run):
    if run.successful:
        return False
    for step in run:
        for task in step:
            if task.finished_at is not None and not task.successful:
                return True
    return False


def run_namespace(run):
    for tag in run.tags:
        if tag.startswith(("user:", "production:")):
            return tag
    return "unknown"


def main():
    hours = float(sys.argv[1])
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    namespace(None)
    failures = []
    for name in sys.argv[2:]:
        try:
            runs = list(Flow(name).runs())[:RUNS_PER_FLOW]
        except MetaflowNotFound:
            continue
        for run in runs:
            created = run.created_at.astimezone(timezone.utc)
            if created < cutoff:
                break
            if failed(run):
                failures.append({"flow": name, "run": run.id, "namespace": run_namespace(run)})
    json.dump(failures, sys.stdout)


if __name__ == "__main__":
    main()
