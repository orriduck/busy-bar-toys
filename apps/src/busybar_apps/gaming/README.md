# Gaming

Show a game while its client is open. The title changes from **GAMING** to **WOW**, **WOW FOREVER**, or **MAPLESTORY**. The small line shows the time since the client opened. This is client-open time. It is not an AFK or in-world play measurement.

Each game has its own registered service. New game services use the **Dispensable** group. The cloud scheduler rotates equal services by Hold. A higher group can interrupt a game. Closing the client withdraws its activity.

## Set up this Mac

First enroll the Mac in the control plane. Keep its existing computer identity.

```bash
.venv/bin/pip install -e .
.venv/bin/busy-bar gaming-setup
.venv/bin/busy-bar install --mode cloud
.venv/bin/busy-bar gaming-status
```

Setup builds a local AppKit helper and creates three owned services. Run setup again to resume an interrupted registration. It reuses the same IDs. It does not change another computer's services. It does not reset a group that you later change in Configuration.

Only the actual client starts a session. Battle.net and MapleStory Launcher do not. Retail WoW uses the `_retail_` client. WoW Forever uses the `_classic_beta_` client. These clients share a bundle ID, so detection also checks the client path. The supported MapleStory client has bundle ID `com.nexon.maplestoryna_exe`.

The counter continues in the background and through sleep. A fresh launch starts a new session. A collector restart retains the session when a matching client is still open. A failed app sample marks activity unknown. It does not report an exit or create a new session.

The native helper reads app launch metadata. It does not read game memory, screenshots, character names, or keyboard input. App paths and process inventory stay on the Mac. The backend receives the game name and elapsed time.

## Shared activity layer

`busybar_shared.activity.ActivityPublisher` handles occurrence identity, pending native deltas, source freshness, and withdrawal. AgentRenderer and GameRenderer both use it. Agent task discovery, token rates, Notifier requests, transport, and global scheduling keep their existing roles.

The title entrance uses the shared native character animation. The time line appears from the first frame. Later time updates change only that line. They keep the same occurrence and do not restart the title or its scroll. A complete scene remains available for recovery and Hold rotation.

## Rendered preview

This offline preview uses synthetic durations. It is not a recording from a running game or a physical Bar.

![Rendered game indicators with mock durations](../../../../docs/images/gaming-rendered-mock.gif)
