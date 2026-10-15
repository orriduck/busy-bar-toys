"""Datadog app: team on-call pages (urgent, Start acknowledges) and alerting monitors."""
import re

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.source import Source
from busybar_shared.command import run, run_json

COLOR = (123, 63, 196)
GLYPH = "#........#/##......##/###....###/##########/##.####.##/##########/.########./..######../...####.../....##...."


def _pup(args):
    result = run_json(["pup", *args, "--no-agent"])
    return result.get("data", result) if isinstance(result, dict) else result


def pages_source(config, refresh):
    team = config["team"]

    def acknowledge(page_id):
        run(["pup", "api", "-X", "POST", f"v2/on-call/pages/{page_id}/acknowledge"])
        refresh()

    def poll(now):
        pages = _pup(["on-call", "pages", "list", "--team", team, "--read-only", "--page-size", "20"])
        return [Notification(f"page:{p['id']}", "urgent", "datadog", "DATADOG", "PAGED!",
                             f"#{p['attributes'].get('key', '')} {p['attributes'].get('title', '')}".strip(),
                             accent=(255, 90, 101), icon=badge(GLYPH, COLOR),
                             primary=lambda page_id=p["id"]: acknowledge(page_id))
                for p in pages if p.get("attributes", {}).get("status") == "triggered"]

    return Source("datadog-pages", "datadog", 30, "state", poll, icon=badge(GLYPH, COLOR))


def monitors_source(config):
    tags = config.get("monitor_tags", f"team:{config['team']},env:prod")

    def poll(now):
        monitors = _pup(["monitors", "list", "--tags", tags, "--read-only", "--limit", "1000",
                         "--jq", '[.[] | select(.overall_state == "Alert") | {id, name}]'])
        items = []
        for monitor in monitors:
            match = re.match(r"^\[[^\]]+\]\[([^\]]+)\]\s*(.*)$", monitor["name"])
            detail = f"{match[1]}: {match[2]}" if match else monitor["name"]
            items.append(Notification(f"monitor:{monitor['id']}", "attention", "datadog", "DATADOG", "MONITOR",
                                      detail, accent=(229, 165, 10), icon=badge(GLYPH, COLOR)))
        return items

    return Source("datadog-monitors", "datadog", 60, "state", poll, icon=badge(GLYPH, COLOR))


def sources(config, state_dir, *, refresh, **_):
    if not config.get("team"):
        return []
    result = [pages_source(config, lambda: refresh("datadog-pages"))]
    if config.get("monitors", True):
        result.append(monitors_source(config))
    return result
