"""Apps built on the agent checker and notifier components."""
import importlib

AGENT_APPS = ("codex", "dots", "claude")


def load_agents():
    for name in AGENT_APPS:
        importlib.import_module(f"{__name__}.{name}")
