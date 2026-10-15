# GitHub notifier app

Show pull request activity that concerns you.

| Item | Level | Title |
|---|---|---|
| A review request for you | attention | `NEED REVIEW` |
| A failed check on your pull request | attention | `CI FAIL` |
| Requested changes on your pull request | attention | `PR NEED CHANGE` |
| An approval of your pull request | info | `PR APPROVED` |
| A review comment or comment on your pull request | info | `PR COMMENTS` |
| A new commit on a pull request that you reviewed | info | `PR COMMIT` |
| A new pull request from a team member | info | `NEW PR` |

Draft pull requests and bot accounts do not create items.
The first check records a baseline and does not alert.

## Requirements

- The [GitHub CLI](https://cli.github.com/), signed in with `gh auth login`.
- Read access to the organization and team for `NEW PR`.

## Configure

```json
{"github": {"org": "my-org", "team": "my-team", "ignore_authors": ["review-bot"], "strip_login_suffix": "-corp"}}
```

| Key | Default | Meaning |
|---|---|---|
| `org`, `team` | not set | Both enable `NEW PR` for team members. |
| `lookback_days` | `3` | The age limit of team pull requests. |
| `ignore_authors` | `[]` | Accounts whose reviews and comments do not alert. |
| `strip_login_suffix` | not set | A suffix removed from logins on the display. |

`{"github": {}}` enables all items except `NEW PR`.
