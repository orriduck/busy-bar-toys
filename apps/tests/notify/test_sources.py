import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from busybar_apps import notifier_sources
from busybar_apps import calendar, credentials, datadog, github, jira, metaflow, terminal
from busybar_shared.command import CommandError


class Recorder:
    """Return canned JSON for command lines that start with a known prefix."""
    def __init__(self, responses):
        self.responses, self.calls = responses, []

    def __call__(self, args, timeout=60):
        self.calls.append(args)
        for prefix, response in self.responses:
            if args[:len(prefix)] == prefix:
                return response(args) if callable(response) else response
        raise AssertionError(f"Unexpected command: {args}")


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_only_configured_apps_are_enabled(self):
        self.assertEqual(notifier_sources({}, self.root, refresh=None, inbox=self.root), [])
        names = [s.name for s in notifier_sources({"terminal": {}, "jira": {}, "github": False}, self.root,
                                                  refresh=None, inbox=self.root)]
        self.assertEqual(names, ["jira-assigned", "terminal-tasks"])

    def test_every_app_builds_its_sources_from_one_configuration(self):
        config = {"datadog": {"team": "t"}, "github": {"org": "o", "team": "t"}, "jira": {},
                  "metaflow": {"python": "/py", "flows": ["F"]}, "terminal": {},
                  "credentials": {"checks": [{"name": "x", "command": ["true"]}]}, "calendar": {}}
        sources = notifier_sources(config, self.root, refresh=lambda name: None, inbox=self.root)
        self.assertEqual({s.app for s in sources}, set(config) - {"credentials"} | {"credentials"})
        self.assertEqual(len({s.name for s in sources}), len(sources))

    def test_datadog_pages_are_urgent_and_start_acknowledges(self):
        pages = {"data": [{"id": "p1", "attributes": {"status": "triggered", "key": "7", "title": "Lagging"}},
                          {"id": "p2", "attributes": {"status": "acknowledged", "key": "8", "title": "Old"}}]}
        refreshed = []
        with patch.object(datadog, "run_json", Recorder([(["pup", "on-call"], pages)])), \
             patch.object(datadog, "run") as run:
            source = datadog.sources({"team": "team-a", "monitors": False}, self.root, refresh=refreshed.append)[0]
            items = source.poll(0)
            self.assertEqual([(i.id, i.level, i.title, i.detail) for i in items], [("page:p1", "urgent", "PAGED!", "#7 Lagging")])
            items[0].primary()
        run.assert_called_once_with(["pup", "api", "-X", "POST", "v2/on-call/pages/p1/acknowledge"])
        self.assertEqual(refreshed, ["datadog-pages"])

    def test_datadog_monitor_names_split_service_and_problem(self):
        monitors = [{"id": 5, "name": "[prod][orders-api] Latency is high"}, {"id": 6, "name": "Plain name"}]
        with patch.object(datadog, "run_json", Recorder([(["pup", "monitors"], monitors)])) as recorder:
            items = datadog.sources({"team": "team-a"}, self.root, refresh=None)[1].poll(0)
        self.assertEqual([i.detail for i in items], ["orders-api: Latency is high", "Plain name"])
        self.assertIn("team:team-a,env:prod", recorder.calls[0])

    def test_github_team_prs_start_with_a_baseline_then_alert_once(self):
        prs = {"items": [{"id": 1, "node_id": "PR_1", "number": 9, "title": "Old", "user": {"login": "alice-co"},
                          "repository_url": "https://api.github.com/repos/o/r"}]}
        responses = [(["gh", "api", "user"], {"login": "me"}),
                     (["gh", "api", "orgs/org/teams/team/members?per_page=100"], [{"login": "me"}, {"login": "alice-co"}]),
                     (["gh", "api", "-X", "GET", "search/issues"], lambda args: prs)]
        with patch.object(github, "run_json", Recorder(responses)) as recorder:
            source = next(s for s in github.sources({"org": "org", "team": "team", "strip_login_suffix": "-co"}, self.root)
                          if s.name == "github-team-prs")
            self.assertEqual(source.poll(time.time()), [])
            prs["items"].append({"id": 2, "node_id": "PR_2", "number": 10, "title": "Bump", "user": {"login": "alice-co"},
                                 "repository_url": "https://api.github.com/repos/o/r"})
            items = source.poll(time.time())
            self.assertEqual([(i.title, i.detail, i.group) for i in items], [("NEW PR", "r #10 alice: Bump", "pr:PR_2")])
            self.assertEqual(source.poll(time.time()), [])
        query = next(a for a in recorder.calls if "search/issues" in a)
        self.assertIn("author:alice-co", " ".join(query))
        self.assertNotIn("author:me", " ".join(query))

    def test_github_own_prs_report_ci_reviews_and_human_comments(self):
        def pr(id, *, ci="SUCCESS", review=None, comment=None, draft=False):
            return {"id": id, "number": 1, "title": "T", "isDraft": draft, "repository": {"name": "r"},
                    "commits": {"nodes": [{"commit": {"oid": "c" + id, "statusCheckRollup": {"state": ci}}}]},
                    "reviews": {"nodes": [review] if review else []}, "comments": {"nodes": [comment] if comment else []}}
        person = lambda login: {"login": login, "__typename": "User"}
        data = {"data": {"viewer": {"login": "me", "pullRequests": {"nodes": [pr("a")]}}}}
        with patch.object(github, "run_json", Recorder([(["gh", "api", "graphql"], lambda args: data)])):
            source = next(s for s in github.sources({"ignore_authors": ["review-bot"]}, self.root) if s.name == "github-my-prs")
            self.assertEqual(source.poll(0), [])
            data["data"]["viewer"]["pullRequests"]["nodes"] = [
                pr("a", ci="FAILURE"),
                pr("b", review={"id": "r1", "state": "APPROVED", "author": person("bob")}),
                pr("c", review={"id": "r2", "state": "CHANGES_REQUESTED", "author": person("bob")}),
                pr("d", comment={"id": "k1", "author": person("review-bot")}),
                pr("e", comment={"id": "k2", "author": {"login": "x", "__typename": "Bot"}}),
                pr("f", comment={"id": "k3", "author": person("carol")}),
                pr("g", ci="FAILURE", draft=True)]
            items = source.poll(0)
        self.assertEqual([(i.title, i.level) for i in items],
                         [("CI FAIL", "attention"), ("PR APPROVED", "info"), ("PR NEED CHANGE", "attention"), ("PR COMMENTS", "info")])

    def test_github_commits_skip_your_own_pushes(self):
        def node(id, oid, login):
            return {"id": id, "number": 3, "title": "T", "isDraft": False, "repository": {"name": "r"},
                    "commits": {"nodes": [{"commit": {"oid": oid, "author": {"user": {"login": login}}}}]}}
        data = {"data": {"viewer": {"login": "me"}, "search": {"nodes": [node("a", "1", "bob")]}}}
        with patch.object(github, "run_json", Recorder([(["gh", "api", "graphql"], lambda args: data)])):
            source = next(s for s in github.sources({}, self.root) if s.name == "github-reviewed-commits")
            source.poll(0)
            data["data"]["search"]["nodes"] = [node("a", "2", "bob"), node("b", "3", "me")]
            items = source.poll(0)
        self.assertEqual([(i.title, i.detail) for i in items], [("PR COMMIT", "r #3 by bob: T")])

    def test_jira_assigned_tickets(self):
        result = {"issues": [{"key": "A-1", "fields": {"summary": "Old"}}]}
        with patch.object(jira, "run_json", Recorder([(["jira", "search"], lambda args: result)])):
            source = jira.sources({}, self.root)[0]
            source.poll(0)
            result["issues"].append({"key": "A-2", "fields": {"summary": "New ticket"}})
            items = source.poll(0)
        self.assertEqual([(i.title, i.detail) for i in items], [("TICKET ASSIGNED", "A-2 New ticket")])

    def test_metaflow_needs_flows_and_a_python(self):
        self.assertEqual(metaflow.sources({"flows": ["F"]}, self.root), [])
        failures = [{"flow": "F", "run": "1", "namespace": "user:a"}]
        with patch.object(metaflow, "run_json", Recorder([(["/py"], lambda args: failures)])) as recorder:
            source = metaflow.sources({"flows": ["F"], "python": "/py"}, self.root)[0]
            source.poll(0)
            failures.append({"flow": "F", "run": "2", "namespace": "user:a"})
            items = source.poll(0)
        self.assertEqual([(i.title, i.detail) for i in items], [("OB RUN FAIL", "F/2 user:a")])
        self.assertEqual(recorder.calls[0][2:], ["24", "F"])

    def test_terminal_notes_skip_bad_files(self):
        inbox = self.root / "inbox"
        self.assertEqual(terminal.run_and_report(inbox, ["sh", "-c", "exit 4"]), 4)
        terminal.run_and_report(inbox, ["true"])
        (inbox / "0-bad.json").write_text("{")
        items = terminal.sources({}, self.root, inbox=inbox)[0].poll(0)
        self.assertEqual(sorted((i.title, i.level) for i in items), [("DONE", "info"), ("FAILED", "attention")])
        failed = next(i for i in items if i.title == "FAILED")
        self.assertTrue(failed.detail.startswith("exit 4: sh -c exit 4"))
        self.assertEqual(list(inbox.glob("*.json")), [])

    def test_credentials_list_every_expired_login(self):
        stamp = self.root / "stamp"
        stamp.write_text(str(time.time() - 13 * 3600))
        checks = [{"name": "old stamp", "stamp": str(stamp), "max_age_hours": 12},
                  {"name": "good login", "command": ["tool", "check"], "expect": "Valid"},
                  {"name": "bad login", "command": ["other", "check"]}]

        def fake(args, timeout=20):
            if args[0] == "other":
                raise CommandError("expired")
            return type("Result", (), {"stdout": "Valid until tomorrow"})()

        with patch.object(credentials, "run", fake):
            source = credentials.sources({"checks": checks}, self.root)[0]
            items = source.poll(0)
        self.assertEqual(source.kind, "state")
        self.assertEqual([(i.title, i.detail) for i in items], [("CRED EXPIRE", "old stamp | bad login")])

    def test_calendar_alerts_shortly_before_a_meeting(self):
        start = time.mktime(time.strptime("2026-10-15 14:00", "%Y-%m-%d %H:%M"))
        output = "2026-10-15 at 14:00 - 14:30\tTeam sync\n2026-10-15 at 16:00 - 17:00\tLater\n"
        self.assertEqual([e["title"] for e in calendar.upcoming(output, start - 60, 120)], ["Team sync"])
        self.assertEqual(list(calendar.upcoming(output, start + 60, 120)), [])


if __name__ == "__main__":
    unittest.main()
