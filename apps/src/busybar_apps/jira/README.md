# Jira notifier app

Show a ticket that is newly assigned to you, with the title `TICKET ASSIGNED`.

## Requirements

- A Jira command-line client that prints search results as JSON.
  The output can be a list of issues or an object with an `issues` list.
  Each issue needs a `key` and `fields.summary` or `summary`.

## Configure

```json
{"jira": {"command": ["jira", "search", "{jql}", "--max", "50"]}}
```

| Key | Default | Meaning |
|---|---|---|
| `command` | `["jira", "search", "{jql}", "--max", "50"]` | The search command. `{jql}` is replaced. |
| `jql` | Unresolved issues assigned to you, updated in seven days | The query. |

The first check records a baseline and does not alert.
