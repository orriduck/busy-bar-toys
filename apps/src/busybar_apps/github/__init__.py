"""GitHub app: team pull requests, review requests, and activity on your own pull requests."""
import time

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.seen import SeenStore
from busybar_notifier.source import Source
from busybar_shared.command import run_json

COLOR = (110, 118, 129)
GLYPH = ".#......#./.##....##./.########./##########/##.####.##/##.####.##/##########/.########./...#..#.../..#....#.."
LEVEL_ACCENT = {"info": (180, 186, 194), "attention": (229, 165, 10)}


def _gh(args):
    return run_json(["gh", *args])


def _search(query):
    return _gh(["api", "-X", "GET", "search/issues", "-f", f"q={query}", "-f", "sort=created", "-f", "per_page=100"])["items"]


def _short(login, strip):
    return login[: -len(strip)] if strip and login.endswith(strip) else login


def _item(id, group, level, title, repo, number, detail):
    return Notification(id, level, "github", "GITHUB", title, f"{repo} #{number} {detail}",
                        accent=LEVEL_ACCENT[level], icon=badge(GLYPH, COLOR), group=group)


class _People:
    def __init__(self, config):
        self.ignore = set(config.get("ignore_authors", ()))
        self.strip = config.get("strip_login_suffix", "")

    def human(self, author, me):
        if not author or author.get("login") == me or author.get("__typename") == "Bot":
            return False
        login = author["login"]
        return login not in self.ignore and not login.endswith(("[bot]", "-apps"))

    def short(self, login):
        return _short(login, self.strip)


def team_source(config, state_dir, people):
    seen = SeenStore(state_dir / "seen-github-team-prs.json")
    org, team = config["org"], config.get("team")
    lookback = config.get("lookback_days", 3)
    cache = {"members": [], "at": 0}

    def poll(now):
        if time.monotonic() - cache["at"] > 3600 or not cache["at"]:
            me = _gh(["api", "user"])["login"]
            members = _gh(["api", f"orgs/{org}/teams/{team}/members?per_page=100"])
            cache["members"] = [m["login"] for m in members if m["login"] != me]
            cache["at"] = time.monotonic()
        if not cache["members"]:
            return []
        since = time.strftime("%Y-%m-%d", time.gmtime(now - lookback * 86400))
        query = " ".join(["is:pr", "draft:false", f"org:{org}", f"created:>={since}",
                          *(f"author:{m}" for m in cache["members"])])
        return [_item(f"team-pr:{i['id']}", f"pr:{i['node_id']}", "info", "NEW PR", i["repository_url"].rsplit("/", 1)[-1],
                      i["number"], f"{people.short(i['user']['login'])}: {i['title']}")
                for i in seen.fresh(_search(query), lambda i: i["id"])]

    return Source("github-team-prs", "github", 60, "event", poll)


def review_source(state_dir, people):
    seen = SeenStore(state_dir / "seen-github-review-requests.json")

    def poll(now):
        items = _search("is:pr is:open archived:false user-review-requested:@me")
        return [_item(f"review-request:{i['id']}", f"pr:{i['node_id']}", "attention", "NEED REVIEW",
                      i["repository_url"].rsplit("/", 1)[-1], i["number"], f"{people.short(i['user']['login'])}: {i['title']}")
                for i in seen.fresh(items, lambda i: i["id"])]

    return Source("github-review-requests", "github", 60, "event", poll)


PR_FIELDS = """id number title isDraft repository { name }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } author { user { login } } } } }
  reviews(last: 1) { nodes { id state author { login __typename } } }
  comments(last: 1) { nodes { id author { login __typename } } }"""
MINE = "query { viewer { login pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { %s } } } }" % PR_FIELDS
REVIEWED = """query { viewer { login } search(query: "is:pr is:open archived:false reviewed-by:@me -author:@me", type: ISSUE, first: 30) {
  nodes { ... on PullRequest { %s } } } }""" % PR_FIELDS
REVIEW_TITLES = {"APPROVED": ("info", "PR APPROVED"), "CHANGES_REQUESTED": ("attention", "PR NEED CHANGE"),
                 "COMMENTED": ("info", "PR COMMENTS")}


def own_source(state_dir, people):
    seen = SeenStore(state_dir / "seen-github-my-prs.json")

    def poll(now):
        viewer = _gh(["api", "graphql", "-f", f"query={MINE}"])["data"]["viewer"]
        items = []
        for pr in viewer["pullRequests"]["nodes"]:
            if pr["isDraft"]:
                continue
            repo, number, group = pr["repository"]["name"], pr["number"], f"pr:{pr['id']}"
            commit = (pr["commits"]["nodes"] or [{}])[0].get("commit") or {}
            if (commit.get("statusCheckRollup") or {}).get("state") in ("FAILURE", "ERROR"):
                items.append(_item(f"ci:{pr['id']}:{commit['oid']}", group, "attention", "CI FAIL", repo, number, pr["title"]))
            review = (pr["reviews"]["nodes"] or [None])[0]
            if review and people.human(review["author"], viewer["login"]) and review["state"] in REVIEW_TITLES:
                level, title = REVIEW_TITLES[review["state"]]
                items.append(_item(f"review:{review['id']}", group, level, title, repo, number,
                                   f"by {people.short(review['author']['login'])}"))
            comment = (pr["comments"]["nodes"] or [None])[0]
            if comment and people.human(comment["author"], viewer["login"]):
                items.append(_item(f"comment:{comment['id']}", group, "info", "PR COMMENTS", repo, number,
                                   f"by {people.short(comment['author']['login'])}"))
        return seen.fresh(items, lambda n: n.id)

    return Source("github-my-prs", "github", 120, "event", poll)


def commit_source(state_dir, people):
    seen = SeenStore(state_dir / "seen-github-reviewed-commits.json")

    def poll(now):
        data = _gh(["api", "graphql", "-f", f"query={REVIEWED}"])["data"]
        items = []
        for pr in data["search"]["nodes"]:
            commit = ((pr.get("commits") or {}).get("nodes") or [{}])[0].get("commit")
            if not commit or pr.get("isDraft"):
                continue
            who = ((commit.get("author") or {}).get("user") or {}).get("login")
            if who == data["viewer"]["login"]:
                continue
            items.append(_item(f"commit:{pr['id']}:{commit['oid']}", f"pr:{pr['id']}", "info", "PR COMMIT",
                               pr["repository"]["name"], pr["number"], f"by {people.short(who)}: {pr['title']}" if who else pr["title"]))
        return seen.fresh(items, lambda n: n.id)

    return Source("github-reviewed-commits", "github", 120, "event", poll)


def sources(config, state_dir, **_):
    people = _People(config)
    result = [review_source(state_dir, people), own_source(state_dir, people), commit_source(state_dir, people)]
    if config.get("org") and config.get("team"):
        result.append(team_source(config, state_dir, people))
    return result
