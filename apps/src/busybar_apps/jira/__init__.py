"""Jira app: newly assigned tickets from a configurable command-line client."""
from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.seen import SeenStore
from busybar_notifier.source import Source
from busybar_shared.command import run_json

COLOR = (31, 111, 235)
GLYPH = "....##..../...####.../..##..##../.##.##.##./##.####.##/##.####.##/.##.##.##./..##..##../...####.../....##...."
JQL = "assignee = currentUser() AND resolution = Unresolved AND updated >= -7d ORDER BY updated DESC"


def sources(config, state_dir, **_):
    seen = SeenStore(state_dir / "seen-jira.json")
    command = config.get("command", ["jira", "search", "{jql}", "--max", "50"])
    jql = config.get("jql", JQL)

    def poll(now):
        result = run_json([part.replace("{jql}", jql) for part in command])
        issues = result if isinstance(result, list) else result.get("issues", [])
        return [Notification(f"jira:{i['key']}", "attention", "jira", "JIRA", "TICKET ASSIGNED",
                             f"{i['key']} {(i.get('fields') or {}).get('summary') or i.get('summary') or ''}".strip(),
                             accent=(229, 165, 10), icon=badge(GLYPH, COLOR))
                for i in seen.fresh(issues, lambda i: i["key"])]

    return [Source("jira-assigned", "jira", 120, "event", poll)]
