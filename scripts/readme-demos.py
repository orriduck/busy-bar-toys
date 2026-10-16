#!/usr/bin/env python3
"""Build offline README clips. No credentials, device access, or source polling."""
import argparse
from dataclasses import replace
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

from PIL import Image, ImageDraw, ImageFont

from busybar_agents.motion import MotionDirector
from busybar_agents.tokens import TokenUsage
from busybar_agents.view import StandbyTimer
from busybar_apps import load_agents
from busybar_apps.samples import samples
from busybar_notifier.badge import badge
from busybar_notifier.display import entrance_seconds
from busybar_notifier.presenter import NotificationPresenter
from busybar_shared.graphics import clock_font, clock_text, draw_clock, tiny_text

ROOT = Path(__file__).resolve().parents[1]
FPS = 30
WALL = datetime(2026, 10, 15, 15, 59, 58, tzinfo=timezone.utc).timestamp()
SIZE = (600, 252)

# Reuse the native .anim decoder used by the existing motion preview.
spec = importlib.util.spec_from_file_location("motion_preview", ROOT / "scripts/motion-preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def calendar_frame(now=WALL):
    """A labeled illustration of the default view, not a firmware screenshot."""
    image = Image.new("RGB", (72, 16))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((11, 1, 24, 14), radius=2, fill="white")
    draw.rectangle((11, 2, 24, 5), fill="#FF6955")
    draw.rectangle((13, 0, 14, 3), fill="#BBBBBB")
    draw.rectangle((21, 0, 22, 3), fill="#BBBBBB")
    tiny_text(draw, (14, 8), "15", "#111111")
    draw_clock(draw, (27, 1), clock_text(now))
    tiny_text(draw, (27, 10), "OCT, THU", "#606060")
    return image


class Device(preview.PreviewDevice):
    """Software compositor. Native scrolling text uses an illustrative font."""

    def frame(self):
        now = self.clock()
        widgets = [e for e in self.widgets.values() if e["until"] > now]
        canvas = Image.new("RGB", (72, 16)) if widgets else calendar_frame(WALL + now)
        for e in sorted(widgets, key=lambda item: item.get("z_index", 0)):
            if e["type"] == "animation":
                fps, sections, frames = self.assets[e["path"]]
                first, last = sections.get(e.get("section", "default"), next(iter(sections.values())))
                length = last - first + 1
                index = max(0, int((now - e["started"]) * fps + 1e-6))
                index = index % length if e.get("loop") else min(index, length - 1)
                image = frames[first + index]
            elif e["type"] == "text":
                image = self.text_frame(e, now - e["started"])
            else:
                image = e["image"]
            canvas.paste(image, (e.get("x", 0), e.get("y", 0)), image if image.mode == "RGBA" else None)
        return canvas

    @staticmethod
    def text_frame(e, age):
        text = e["text"]
        bold = e.get("font") == "bold"
        width = round(clock_font().getlength(text)) if bold else max(1, len(text) * 4 - 1)
        height = 9 if bold else 7
        image = Image.new("RGBA", (max(1, width), height))
        draw = ImageDraw.Draw(image)
        if bold:
            draw_clock(draw, (0, 2), text)
        else:
            # Firmware small glyphs start two rows below the element's y.
            tiny_text(draw, (0, 2), text, e.get("color", "#FFFFFFFF"))
        viewport = e.get("width", width)
        travel = max(0, width - viewport)
        # Approximate firmware text scrolling. This is not a timing reference.
        delay = e.get("scroll_start_delay", 1000) / 1000
        repeat = e.get("scroll_repeat_delay", 2000) / 1000
        period = delay + travel / 15 + repeat
        offset = min(travel, max(0, (age % period - delay) * 15)) if travel else 0
        return image.crop((round(offset), 0, round(offset) + viewport, height))


def card(screen, title, phase, note):
    image = Image.new("RGB", SIZE, "#11151D")
    draw = ImageDraw.Draw(image)
    draw.text((12, 8), "DEMO / OFFLINE RENDER / " + title, fill="#F3F5F8", font=ImageFont.load_default(size=16))
    image.paste(screen.resize((576, 128), Image.Resampling.NEAREST), (12, 36))
    draw.text((12, 176), phase, fill="#D6DFED", font=ImageFont.load_default(size=20))
    draw.text((12, 216), note, fill="#8795AB", font=ImageFont.load_default(size=16))
    return image


def task(state, source="chatgpt"):
    return SimpleNamespace(state=state, source=source, session_id="demo")


def agent_clip(kind):
    tick = [0.0]
    device = Device(lambda: tick[0], calendar_frame())
    reduced = kind == "reduced-motion"
    motion = MotionDirector(device, reduced=reduced, clock=lambda: tick[0])
    timer = StandbyTimer()
    source = {"your-dot": "dots", "claude": "claude"}.get(kind, "chatgpt")
    plans = {
        "codex-cycle": [(0, "working", "Task starts"), (3, "waiting", "Needs input or approval"),
                        (5, "working", "Task resumes"), (7, "done", "Standby: wait ten seconds")],
        "your-dot": [(0, "working", "Your dot task"), (3, "waiting", "Your dot needs input"),
                     (5, "working", "Your dot resumes")],
        "claude": [(0, "working", "Optional Claude Code source"), (3, "waiting", "Needs input"),
                   (5, "working", "Task resumes")],
        "state-colors": [(0, "working", "Blue: running"), (2, "waiting", "Yellow: needs input"),
                         (4, "error", "Red: error"), (6, "unknown", "Gray: stale update"),
                         (8, "done", "White: standby")],
        "clock-tokens": [(0, "working", "Clock and current-turn input/output tokens")],
        "start-pause": [(0, "working", "Task is running"), (2, None, "Start/Pause: return to calendar"),
                        (5, "working", "New task turn: restore Codex")],
        "reduced-motion": [(0, "working", "Static blue status light"), (2, "waiting", "Static approval state"),
                           (4, "done", "Static standby state")],
    }
    schedule = plans[kind]
    duration = {"codex-cycle": 19, "state-colors": 10}.get(kind, 7)
    active, label, next_step, returned = None, "", 0, False
    images = []
    for number in range(duration * FPS):
        tick[0] = t = number / FPS
        if next_step < len(schedule) and t >= schedule[next_step][0]:
            _, state, label = schedule[next_step]
            active = task(state, source) if state else None
            if active is None:
                motion.hide()
            next_step += 1
        if active and not returned:
            # Synthetic reported counters rise within a turn and reset on a new turn.
            turn_time = max(0, t - 5) if kind == "start-pause" and t >= 5 else t
            up, down = 1200 + int(turn_time) * 730, 84 + int(turn_time) * 165
            # Update once a second to illustrate discrete usage reports.
            if number % FPS == 0 or motion.current is None:
                motion.show(active, WALL + t, 1, TokenUsage(up, down))
        motion.advance()
        if kind == "codex-cycle" and active.state == "done" and motion.standby_visible:
            timer.shown(t)
            if timer.expired(t):
                motion.hide()
                returned = True
                label = "Ten seconds elapsed: restore calendar"
        note = "Synthetic events, time and token counts. Calendar is an illustration."
        images.append(card(device.frame(), kind.upper(), label, note))
    return images


def notification_clip(items, *, restore_agent=False, shared=False):
    tick = [0.0]
    device = Device(lambda: tick[0], calendar_frame())
    motion = MotionDirector(device, clock=lambda: tick[0])
    presenter = NotificationPresenter(device, clock=lambda: tick[0])
    images = []
    for item in items:
        # Keep the full ten-second aircraft hold. Shorten other information holds.
        hold = 10 if item.app == "adsbao" else 3
        if restore_agent:
            motion.show(task("working"), WALL, usage=TokenUsage(12000, 1500))
        for number in range(FPS):
            motion.advance()
            images.append(card(device.frame(), item.app.upper(), "Current agent view" if restore_agent else "Default calendar",
                               "Synthetic notification. No external action is run."))
            tick[0] += 1 / FPS
        device.clear()
        motion.invalidate()
        presenter.start(item, demo=True)
        intro = tick[0]
        end = intro + entrance_seconds(item) + hold
        while presenter.active:
            t = tick[0]
            if t >= end:
                presenter.dismiss()
            presenter.advance()
            if item.level == "urgent":
                label = "Urgent: remains visible until condition clears"
                note = "DEMO condition clears after three seconds. No acknowledgement is sent."
            else:
                label = f"{item.brand} / {item.title}"
                note = "Full ten-second hold." if item.app == "adsbao" else "Information/attention holds shortened to three seconds for this clip."
            if shared:
                label = "Mac A owns urgent alert; Mac B waits"
                note = "Scripted ownership example. No second Mac or network connection."
            images.append(card(device.frame(), item.app.upper(), label, note))
            tick[0] += 1 / FPS
        device.clear()
        if restore_agent:
            motion.show(task("working"), WALL + tick[0], usage=TokenUsage(12000, 1500))
        for number in range(FPS):
            motion.advance()
            label = "Restore current Codex task" if restore_agent else "Restore calendar"
            if shared:
                label = "Urgent alert clears; shared display is available"
            images.append(card(device.frame(), item.app.upper(), label, "Calendar is an illustration. Source events are synthetic."))
            tick[0] += 1 / FPS
    return images


def export(name, frames, output):
    path = output / name
    durations = [30 if i % 3 != 2 else 40 for i in range(len(frames))]
    frames[0].save(path.with_suffix(".gif"), save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, optimize=True, disposal=1)
    process = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
                                "-pixel_format", "rgb24", "-video_size", f"{SIZE[0]}x{SIZE[1]}",
                                "-framerate", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
                                "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                                str(path.with_suffix(".mp4"))], stdin=subprocess.PIPE)
    try:
        for frame in frames:
            process.stdin.write(frame.tobytes())
    finally:
        process.stdin.close()
    if process.wait():
        raise RuntimeError("MP4 encoding failed")
    poster_at = {"codex-cycle": 2, "your-dot": 1, "claude": 1}.get(name, 4)
    frames[min(len(frames) - 1, poster_at * FPS)].save(path.with_suffix(".png"))
    return {"name": name, "frames": len(frames), "seconds": len(frames) / FPS,
            "gif_bytes": path.with_suffix(".gif").stat().st_size,
            "mp4_bytes": path.with_suffix(".mp4").stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/demos")
    parser.add_argument("--only", nargs="*", help="Render selected clip names")
    args = parser.parse_args()
    if not shutil.which("ffmpeg"):
        parser.error("ffmpeg is required to encode MP4 files")
    args.output.mkdir(parents=True, exist_ok=True)
    load_agents()
    notifications = samples()
    from busybar_apps import terminal
    done = next(n for n in notifications if n.id == "sample:done")
    notifications.append(replace(done, id="sample:failed", level="attention", title="FAILED",
                                 detail="demo build: exit 1", icon=badge(terminal.GLYPH, terminal.COLOR)))
    names = ["codex-cycle", "your-dot", "claude", "state-colors", "clock-tokens", "start-pause", "reduced-motion"]
    names += ["adsbao", "github", "datadog", "jira", "metaflow", "terminal", "credentials", "calendar", "shared-display"]
    if args.only and set(args.only) - set(names):
        parser.error("Unknown clip names: " + ", ".join(sorted(set(args.only) - set(names))))
    manifest = []
    for name in names:
        if args.only and name not in args.only:
            continue
        if name in names[:7]:
            frames = agent_clip(name)
        else:
            items = ([notifications[0]] if name == "shared-display" else [n for n in notifications if n.app == name])
            frames = notification_clip(items, restore_agent=name == "adsbao", shared=name == "shared-display")
        manifest.append(export(name, frames, args.output))
        print(f"{name}: {len(frames) / FPS:.2f}s", flush=True)
    if not args.only:
        (args.output / "manifest.json").write_text(json.dumps({"fps": FPS, "synthetic": True, "clips": manifest}, indent=2) + "\n")


if __name__ == "__main__":
    main()
