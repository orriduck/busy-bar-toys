"""Apps built on the agent checker and notifier components."""
import importlib
from pathlib import Path

AGENT_APPS = ("codex", "dots", "claude")
NOTIFIER_APPS = ("datadog", "github", "jira", "metaflow", "terminal", "credentials", "calendar")


def load_agents():
    for name in AGENT_APPS:
        importlib.import_module(f"{__name__}.{name}")


def notifier_sources(config, state_dir, *, refresh, inbox):
    """Build the sources of every app that the private configuration enables."""
    result = []
    for name in NOTIFIER_APPS:
        section = config.get(name)
        if section in (None, False):
            continue
        module = importlib.import_module(f"{__name__}.{name}")
        result += module.sources(section if isinstance(section, dict) else {}, Path(state_dir),
                                 refresh=refresh, inbox=inbox)
    return result
