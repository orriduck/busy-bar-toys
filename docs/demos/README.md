# Use-case demos

English | [简体中文](#简体中文)

These clips show the front display with synthetic input.
They use `MotionDirector`, `NotificationPresenter`, app icons, sample notifications,
and the native animation assets from this checkout.
No clip reads an account, calls a device, polls an app, or runs a notification action.

Open a GIF for a looping preview. Download an MP4 to pause or replay it locally.
The root [English](../../README.md#watch-the-use-cases) and
[Chinese](../../README.zh-CN.md#看演示) READMEs contain the full gallery.

| Clip | What to watch | Setup |
|---|---|---|
| [Codex cycle](codex-cycle.mp4) | Blue running light, yellow input state, white standby, then calendar after ten seconds. | [Codex](../../apps/src/busybar_apps/codex/README.md) |
| [Your dot](your-dot.mp4) | The five-point source icon and task states. | [Your dot](../../apps/src/busybar_apps/dots/README.md) |
| [Claude Code](claude.mp4) | The orange source icon and task states. This app is optional. | [Claude Code](../../apps/src/busybar_apps/claude/README.md) |
| [State colors](state-colors.mp4) | Running, input, error, stale update, and standby. The stale state is injected. | [Agent checker](../../agent-checker/README.md) |
| [Clock and tokens](clock-tokens.mp4) | A minute change, digit rolls, and separate current-turn input/output counts. | [Agent checker](../../agent-checker/README.md) |
| [Start/Pause](start-pause.mp4) | Scripted press: calendar until a new task turn starts. | [Button setup](../../README.md#enable-wi-fi-button-input) |
| [Reduced motion](reduced-motion.mp4) | Static running, input, and standby states. | [Static mode](../../README.md#check-or-stop-the-service) |
| [ADSBao](adsbao.mp4) | `ADSBAO` rolls to `JBU462`; only `A320` appears below; the current Codex view returns. | [ADSBao](../../apps/src/busybar_apps/adsbao/README.md) |
| [Datadog](datadog.mp4) | An urgent page and an attention-level monitor alert. | [Datadog](../../apps/src/busybar_apps/datadog/README.md) |
| [GitHub](github.mp4) | Review request, failed CI, changes requested, new PR, new commit, approval, and comments. | [GitHub](../../apps/src/busybar_apps/github/README.md) |
| [Jira](jira.mp4) | A newly assigned ticket. | [Jira](../../apps/src/busybar_apps/jira/README.md) |
| [Metaflow](metaflow.mp4) | A failed flow run. | [Metaflow](../../apps/src/busybar_apps/metaflow/README.md) |
| [Terminal](terminal.mp4) | A command completes, then a command fails. | [Terminal](../../apps/src/busybar_apps/terminal/README.md) |
| [Credentials](credentials.mp4) | A login needs renewal. | [Credentials](../../apps/src/busybar_apps/credentials/README.md) |
| [Calendar app](calendar.mp4) | A meeting starts soon. This alert is separate from the default device calendar. | [Calendar app](../../apps/src/busybar_apps/calendar/README.md) |
| [Shared display](shared-display.mp4) | One urgent owner remains visible while a second host waits. This is a scripted illustration. | [Sharing](../../README.md#share-one-bar-between-macs) |

## Timing and limits

- Native animations are sampled at 30 frames per second. GIF delays alternate
  between 30, 30, and 40 milliseconds. MP4 files use 30 frames per second.
- The Codex cycle includes the full ten-second standby period. It uses the
  production `StandbyTimer` before the calendar return.
- The aircraft clip keeps the full entrance and ten-second title hold.
- Other notification holds are shortened to three seconds after entrance.
  Urgent demo conditions clear after three seconds. A real urgent item does not
  time out at three or ten seconds; it stays until its condition clears or its
  primary action succeeds.
- Button presses and shared-host ownership are scripted. These clips do not
  test a physical button or multi-host contention.
- The calendar image is an illustration. Native scrolling text uses an
  approximate software compositor. These parts are not firmware pixel or timing
  references. Cloud transfer delays and Wi-Fi latency are not modeled.
- Token counts in these clips are synthetic. Live counts come from Codex rollout usage.
  Sources that do not report usage show `--` in normal operation.
- App support does not mean an app is enabled on the viewer's Mac.
  Rendering the Claude clip does not install Claude hooks.

For separate hardware evidence, see the [actual-device mock capture](../images/actual-staggered-intro.png).
It uses synthetic aircraft data. Cloud sampling does not resolve all native frames.

## Regenerate

Run from the repository root. Use the project's installed Python environment.
Install `ffmpeg` with your package manager before encoding MP4 files.

```sh
.venv/bin/python scripts/readme-demos.py
```

To render selected clips to a temporary directory:

```sh
.venv/bin/python scripts/readme-demos.py --only codex-cycle adsbao --output .local/readme-demos
```

The command writes one GIF, MP4, and poster PNG per clip.
A full run also writes [manifest.json](manifest.json) with durations, frame counts,
and file sizes. Sample values are fixed for repeatable review.
Do not replace synthetic values with credentials, account names, or private events.

## 简体中文

这些短片使用模拟输入展示设备正面。
它们复用项目中的 `MotionDirector`、`NotificationPresenter`、app 图标、
模拟通知和原生动画素材。
生成过程不读取账号、不连接设备、不轮询 app，也不执行通知动作。

根目录的[中文 README](../../README.zh-CN.md#看演示)含全部 16 组演示。
下载上表的 MP4，可在本地暂停与重播；对应 GIF 可循环播放。

- Codex 短片展示运行、请求输入、待机，以及十秒后恢复日历。
  十秒计时使用项目中的 `StandbyTimer`。
- 短片中的 token 计数是模拟值。真实计数来自 Codex 的用量记录。
  没有上报用量的来源在实际运行时显示 `--`。
- Your dot 和 Claude Code 短片展示各自的图标与状态。
  Claude Code 是可选 app；生成演示不会安装 hooks。
- 状态短片展示蓝、黄、红、灰、白五种状态。灰色过期状态由脚本注入。
- 时钟与 token 短片展示分钟变化、数字滚动，以及当前轮的输入／输出计数。
- Start/Pause 短片模拟按键：先回日历，等新一轮任务开始再恢复。
- ADSBao 短片保留完整入场和十秒显示，下行只显示机型。
  结束时恢复当前 Codex；没有活动任务时，服务恢复日历。
- Datadog、GitHub、Jira、Metaflow、Terminal、Credentials、Calendar
  短片覆盖各 app 的通知类型。Calendar 会议通知与设备默认日历是不同功能。
- 静态模式短片展示减少动态效果。共享显示短片用脚本说明紧急通知的显示权。

除飞机外，通知停留缩短为三秒，并在字幕中标记。
紧急演示条件在三秒后解除；真实紧急通知不会在三秒或十秒后自动关闭。
它会持续到情况解除或主动作成功。

动画按每秒三十帧采样。GIF 使用 30、30、40 毫秒交替延时，MP4 为每秒三十帧。
日历是示意图，原生滚动文字是近似模拟。
短片不模拟云端或 Wi-Fi 延迟，也不代表实体按键或两台 Mac 的实测。
单独的硬件证据见[设备实测模拟航班截图](../images/actual-staggered-intro.png)。

在仓库根目录运行上述生成命令即可重新生成全部素材。
需要项目 Python 环境和 `ffmpeg`。
每组输出 GIF、MP4 和封面 PNG；完整生成还会输出帧数、时长和大小清单。
所有事件、时间、token 计数与航班均为固定模拟值，不包含用户私有数据。
