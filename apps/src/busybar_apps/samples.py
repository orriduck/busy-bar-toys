"""Clearly labeled sample notifications for demonstrations and previews."""
from busybar_notifier.badge import badge
from busybar_notifier.model import URGENT_COLOR, Notification
from . import calendar, credentials, datadog, github, jira, metaflow, terminal
from .adsbao.commands import mock_aircraft
from .adsbao.display import notification as aircraft


def samples():
    def item(id, level, module, brand, title, detail, accent):
        return Notification(f"sample:{id}", level, module.__name__.rsplit(".", 1)[-1], brand, title, detail,
                            accent=accent, icon=badge(module.GLYPH, URGENT_COLOR if level == "urgent" else module.COLOR))

    amber = (229, 165, 10)
    return [
        item("page", "urgent", datadog, "DATADOG", "PAGED!", "#1337 [prod][demo-service] Consumer is lagging", (255, 90, 101)),
        item("monitor", "attention", datadog, "DATADOG", "MONITOR", "demo-service: latency is high", amber),
        item("review", "attention", github, "GITHUB", "NEED REVIEW", "demo-repo #260 octocat: Bump a dependency", amber),
        item("ci", "attention", github, "GITHUB", "CI FAIL", "demo-repo #160 Add tools", amber),
        item("changes", "attention", github, "GITHUB", "PR NEED CHANGE", "demo-repo #155 by octocat", amber),
        item("ticket", "attention", jira, "JIRA", "TICKET ASSIGNED", "DEMO-42 Rotate a credential", amber),
        item("run", "attention", metaflow, "METAFLOW", "OB RUN FAIL", "TrainingFlow/42", amber),
        item("cred", "attention", credentials, "LOGIN", "CRED EXPIRE", "demo login", amber),
        item("pr", "info", github, "GITHUB", "NEW PR", "demo-repo #252 octocat: Bump a dependency", (180, 186, 194)),
        item("commit", "info", github, "GITHUB", "PR COMMIT", "demo-repo #164 by octocat", (180, 186, 194)),
        item("approved", "info", github, "GITHUB", "PR APPROVED", "demo-repo #259 by octocat", (180, 186, 194)),
        item("comments", "info", github, "GITHUB", "PR COMMENTS", "demo-repo #259 by octocat", (180, 186, 194)),
        item("done", "info", terminal, "TERMINAL", "DONE", "make test (3m12s)", (82, 222, 150)),
        item("meeting", "info", calendar, "CALENDAR", "MEETING", "14:00 Team sync", (140, 180, 255)),
        aircraft(mock_aircraft()),
    ]
