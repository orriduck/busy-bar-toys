# Metaflow notifier app

Show a failed run of a watched Metaflow flow, with the title `OB RUN FAIL`.

## Requirements

- A Python environment with the Metaflow client, configured for your metadata service.
- The names of the flows to watch.

The app runs `failures.py` in that environment every five minutes.
A run fails when a task ended without success.

## Configure

```json
{"metaflow": {"python": "~/.venvs/metaflow/bin/python", "flows": ["TrainingFlow"], "lookback_hours": 24}}
```

| Key | Default | Meaning |
|---|---|---|
| `python` | required | The Python executable with Metaflow. |
| `flows` | required | Flow names. The five latest runs of each flow are checked. |
| `lookback_hours` | `24` | Older runs are ignored. |
