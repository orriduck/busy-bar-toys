# Calendar notifier app

Show a meeting shortly before it starts, with the title `MEETING`.

## Requirements

- [icalBuddy](https://hasseg.org/icalBuddy/), for example from Homebrew: `brew install ical-buddy`.
- A calendar account in the macOS Calendar app.
- Calendar access for the program that runs the service. Approve the macOS request.

## Configure

```json
{"calendar": {"lead_minutes": 2}}
```

The app reads today's events every 30 seconds.
Each event alerts once.
