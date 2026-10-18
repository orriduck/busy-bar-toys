# busy-bar-toys

[English](README.md) | 简体中文

在 BUSY Bar 上显示本机 AI agent 状态和简短通知。
一个后台服务采集本机 app 的数据。
设备原生日历是默认界面。

## 云端控制面

打开 [BUSY Traffic Control（BTC）](https://btc.orriduck.workers.dev)。
使用 BUSY 设备 API token 登录。
Cloudflare 后端负责调度和写屏。
每台 Mac 向自己的注册服务发送本机状态和通知。
关闭浏览器后，云端仍会继续调度。
管理页通过 SSE 同步状态。

| 页面 | 用途 |
|---|---|
| **Display** | 查看真实设备像素、当前消息和等待队列。 |
| **Services** | 添加服务、连接本机来源，以及开关各项服务。 |
| **Configuration** | 把本机服务移入优先级组，设置 Hold 和 Heartbeat。 |
| **Device** | 检查连接、当前控制者和预览诊断，或退出登录。 |

队列用细进度条标记当前消息。
轮播条显示交替播放的后台服务。
新消息进入列表，移除的消息淡出。
展开一行，可查看正文、来源、完整 ID 和可用操作。

Services 按电脑显示紧凑的服务卡片。
接入引导提供本机来源的连接命令。
创建服务不会启动本机 app。
其他电脑始终可见，但只能读取。

| 全局组 | 行为 |
|---|---|
| **Interception** | 打断下方两组。保留被打断的消息，稍后恢复。 |
| **Follow queue** | 按消息到达顺序播放。被打断后继续。 |
| **Dispensable** | 上方两组为空时显示后台状态。各服务按 Hold 轮换。 |

所有电脑在同一组内的服务同级。
行序不会增加优先级。
只能拖动本机服务换组。
换组立即保存。
修改 Hold 或 Heartbeat 后，选择 **Save changes**。

**Hold** 决定后台服务的单次轮播时长，以及定时消息的累计可见时长。
**Heartbeat** 决定服务允许的上报间隔。
发送端逐条声明按时间结束，或由来源结束。
发送端也决定何时发送新的事件。
Agent 状态与批准、提问请求使用不同的服务。

界面支持亮色、暗色和自动主题。
移动端使用悬浮的图标导航栏。
可以把 BTC 作为 PWA 添加到主屏幕。
实时预览需要配置 Wi-Fi 桥，并打开 **Live preview**。
目标为 30 fps，Device 显示实测速率。
预览失联不会停止云端调度。

<details>
<summary>查看当前界面，使用本地模拟数据</summary>

这些截图使用模拟服务和模拟设备。
它们不代表真实设备已经连接。

![本地模拟队列的插入、打断、轮播和移除](docs/images/control-plane-queue.gif)

| Configuration | Services |
|---|---|
| ![桌面配置页，本地模拟数据](docs/images/control-plane-config.png) | ![桌面服务页，本地模拟数据](docs/images/control-plane-services.png) |

</details>

连接 Mac 时，按[客户端指南](docs/cloud-mode.zh-CN.md)操作。
启动 cloud 观察服务前，先注册 Agent status 和 Agent requests。
指南包含电脑接入、浏览器配对、来源路由和迁移。
只用 Codex 的 Mac 不需要 Claude hooks。

如需模拟设备，可用 `demo-token` 进入[共享预览](https://busy-bar-control-plane-preview.orriduck.workers.dev)。
共享预览只使用模拟数据。
另见[管理页指南](control-plane/README.zh-CN.md)和[协议](control-plane/PROTOCOL.md)。
下方[安装](#安装)步骤使用 standalone 模式。

## 看演示

下列归档短片使用模拟事件和离线绘制。
生成演示无需设备、凭据或已启用的集成。
每段归档短片都有 `DEMO / OFFLINE RENDER` 标记。
部分短片早于当前 token 速率和云端调度。
这些行为以当前文字说明为准。
日历为示意图，原生文字的滚动为近似模拟。
需要暂停或重播时，可下载 MP4 在本地播放。

| | |
|---|---|
| **Codex：运行 → 批准 → 待机 → 日历** · [MP4](docs/demos/codex-cycle.mp4)<br>![Codex：运行 → 批准 → 待机 → 日历; offline DEMO](docs/demos/codex-cycle.gif) | **ADSBao：飞机提示 → 恢复当前 Codex** · [MP4](docs/demos/adsbao.mp4)<br>![ADSBao：飞机提示 → 恢复当前 Codex; offline DEMO](docs/demos/adsbao.gif) |
| **Your dot：独立来源图标** · [MP4](docs/demos/your-dot.mp4)<br>![Your dot：独立来源图标; offline DEMO](docs/demos/your-dot.gif) | **Start/Pause → 日历 → 新一轮任务** · [MP4](docs/demos/start-pause.mp4)<br>![Start/Pause → 日历 → 新一轮任务; offline DEMO](docs/demos/start-pause.gif) |
| **时钟与数字动画** · [MP4](docs/demos/clock-tokens.mp4)<br>![时钟与数字动画; offline DEMO](docs/demos/clock-tokens.gif) | **运行、批准、错误、过期、待机** · [MP4](docs/demos/state-colors.mp4)<br>![运行、批准、错误、过期、待机; offline DEMO](docs/demos/state-colors.gif) |

Codex 短片保留完整的十秒待机。
飞机短片保留完整的十秒航班显示。
其他通知的停留缩短为三秒。
紧急演示条件在三秒后解除；真实紧急通知会持续显示到解决。

<details>
<summary>更多演示：所有可选 app、静态模式与共享显示</summary>

| | |
|---|---|
| **Claude Code：可选 hooks** · [MP4](docs/demos/claude.mp4)<br>![Claude Code：可选 hooks; offline DEMO](docs/demos/claude.gif) | **减少动态效果：静态状态** · [MP4](docs/demos/reduced-motion.mp4)<br>![减少动态效果：静态状态; offline DEMO](docs/demos/reduced-motion.gif) |
| **Datadog：紧急 page 与监控告警** · [MP4](docs/demos/datadog.mp4)<br>![Datadog：紧急 page 与监控告警; offline DEMO](docs/demos/datadog.gif) | **GitHub：评审、CI、修改要求与 PR 动态** · [MP4](docs/demos/github.mp4)<br>![GitHub：评审、CI、修改要求与 PR 动态; offline DEMO](docs/demos/github.gif) |
| **Jira：新分配的工单** · [MP4](docs/demos/jira.mp4)<br>![Jira：新分配的工单; offline DEMO](docs/demos/jira.gif) | **Metaflow：运行失败** · [MP4](docs/demos/metaflow.mp4)<br>![Metaflow：运行失败; offline DEMO](docs/demos/metaflow.gif) |
| **Terminal：命令成功或失败** · [MP4](docs/demos/terminal.mp4)<br>![Terminal：命令成功或失败; offline DEMO](docs/demos/terminal.gif) | **Credentials：登录需要续期** · [MP4](docs/demos/credentials.mp4)<br>![Credentials：登录需要续期; offline DEMO](docs/demos/credentials.gif) |
| **Calendar app：即将开始的会议** · [MP4](docs/demos/calendar.mp4)<br>![Calendar app：即将开始的会议; offline DEMO](docs/demos/calendar.gif) | **共享 Bar：紧急通知占用，另一主机等待** · [MP4](docs/demos/shared-display.mp4)<br>![共享 Bar：紧急通知占用，另一主机等待; offline DEMO](docs/demos/shared-display.gif) |

</details>

可选 app 的演示不会在你的 Mac 上启用这些 app。
只有选择使用 Claude Code 时，才需要配置它的 hooks。
共享显示短片使用脚本序列说明所有权规则，不代表两台 Mac 的实测。
见[演示索引、限制与重新生成命令](docs/demos/README.md#简体中文)。
另有[设备实测的模拟航班截图](docs/images/actual-staggered-intro.png)，可单独对照硬件效果。

## 组件与 app

| 组件 | 显示内容 | App |
|---|---|---|
| [Agent checker](agent-checker/README.md) | 任务状态、来源图标、时钟、每秒 token 速率。 | Codex、Your dot、Claude Code |
| [Notifier](notifier/README.md) | 带逐字滚动入场动画的简短通知。 | ADSBao、Datadog、GitHub、Jira、Metaflow、Terminal、Credentials、Calendar |

见[全部 app 及其要求](apps/README.md)。

### Agent 状态

在已配置的 agent app 中开始一个任务，即可显示状态界面。
时钟使用纽约时区和 24 小时制。
琥珀色 ↑ 表示每秒输入 token 数。
青色 ↓ 表示每秒输出 token 数。
它们不是网速，也不是整轮累计用量。
观察窗口约为十秒。
启动后满一秒，服务先使用已观察到的时段。
长时间采样中断或用量不可用时，重新开始测量。

输入包括新输入和首次缓存写入，不包括缓存读取。
输出包括 reasoning token。
Codex 和 Claude Code 都会上报用量。
`--` 表示速率未知，程序不会估算缺失用量。
正面显示缩写，背面显示完整的每秒 token 数。

变化的数字向上滚动，结束后释放动画覆盖层。
旧数字不会继续盖住后续值。
下面是在真实 Bar 上采样的有限 DEMO。
显示的时间和速率均为模拟值。
原任务的帧已排除。
这段采样录像不代表设备帧率测量。

![真实 BUSY Bar：模拟时钟与 token 速率变化](docs/demos/numeric-device-demo.gif)

实现说明见[数字覆盖层生命周期](docs/digit-overlay-lifecycle.md)。

| 光条 | 状态 |
|---|---|
| 上下移动的蓝条 | 任务正在运行。 |
| 黄条 | standalone 模式下，任务需要输入或批准。 |
| 细白条 | 任务已完成或停止。 |
| 红条 | 任务报告错误。 |
| 灰条 | 任务超过 30 分钟没有更新。 |

cloud 模式用独立的 **Agent requests** Notifier 显示批准和提问请求。
其他活动任务可以继续上报状态。

待机十秒后，服务恢复原生日历。
按 Start/Pause 可立即恢复日历。
下一轮任务开始时，服务重新显示 agent 界面。

### 附近飞机

Mac 提供系统定位。
服务通过 Server-Sent Events（SSE）连接接收 [ADSBao](https://adsbao.dev) 的附近飞机数据。
触发范围为三英里，约 4,828 米，按水平距离计算。

飞机图标先入场，旁边显示 `ADSBAO`。
停留半秒后，字符从左到右依次向上滚动，切成航班标识。
相邻字符错开约 67 毫秒。
下面一行只显示机型，例如 `A320`。

完整入场约需 1.77 秒。
航班标识随后保持十秒。
服务再恢复当前 agent 界面或原生日历。
同一架飞机在一次经过期间只提示一次。

### 通知

内置通知使用飞机的入场动画，并显示 app 图标。
图标底色使用 app 的颜色，紧急项目用红色。
详情文字和 LED 表示级别。
红色为紧急，琥珀色为需要处理，app 强调色为一般信息。
定时通知默认十秒后恢复原界面。
cloud 模式使用配置的 Hold 值。
默认情况下，紧急通知一直显示到情况解除或动作成功。
按 Start/Pause 会执行紧急通知的动作，例如确认 Datadog page。
其他通知上按 Start/Pause，会清除全部通知并显示日历。
见 [notifier 规则](notifier/README.md)。

## 环境要求

- macOS，以及 Python 3.10 或更新版本。
- 包含 `swiftc` 和 `xcrun` 的 Apple 命令行工具。
- 已连接互联网的 BUSY Bar，以及适用于该设备的云端 API token。
- 供 Start/Pause 使用的 Wi-Fi 或 USB 本地连接。

保持 Mac 唤醒并连接互联网。
Wi-Fi 按键功能要求 Mac 与 Bar 在局域网内互通。
只要网络允许互通，两台设备可以使用不同的 Wi-Fi 频段。

## 安装

这些步骤安装 standalone 模式。
cloud 模式按[客户端指南](docs/cloud-mode.zh-CN.md)接入。
cloud 模式的安装和状态命令须保留 `--mode cloud`。
省略此参数会选择 standalone 模式。

安装后保留本地仓库。
后台服务使用仓库内的 Python 环境运行。
命令名仍为 `busy-bar`。

1. 克隆仓库。

   ```sh
   git clone https://github.com/orriduck/busy-bar-toys.git
   ```

2. 进入仓库目录。

   ```sh
   cd busy-bar-toys
   ```

3. 创建 Python 环境。

   ```sh
   python3 -m venv .venv
   ```

4. 以可编辑模式安装软件包。

   ```sh
   .venv/bin/python -m pip install -e .
   ```

5. 编译云端凭据助手。

   ```sh
   swiftc scripts/store-token.swift -o .venv/bin/busy-token-store
   ```

6. 编译按键凭据助手。

   ```sh
   swiftc scripts/input-keychain.swift -o .venv/bin/busy-input-keychain
   ```

7. 在 [BUSY 云端 token 页面](https://cloud.busy.app/api-tokens)创建 token。

8. 将 token 存入 macOS 钥匙串。

   ```sh
   .venv/bin/busy-bar token-set
   ```

9. 安装后台服务。

   ```sh
   .venv/bin/busy-bar install
   ```

服务会立即启动，并在登录时自动运行。
后续命令均在仓库目录内执行。
移动目录后，重新执行可编辑安装和后台服务安装。

## 启用 Wi-Fi 按键

1. 配置设备的本地连接。

   ```sh
   .venv/bin/busy-bar input-wifi
   ```

2. 如果 macOS 请求访问钥匙串，选择允许。

3. 重启后台服务。

   ```sh
   .venv/bin/busy-bar install
   ```

配置命令读取设备地址，并将本地 token 存入钥匙串。
在 agent 或飞机界面，按 Start/Pause 可显示日历。
紧急通知的按键规则见上文。

## 启用飞机提示

1. 启动系统定位设置。

   ```sh
   .venv/bin/busy-bar adsbao-location
   ```

2. 在 macOS 弹窗中，允许 **Busy Bar Location** 使用定位。

3. 重启后台服务。

   ```sh
   .venv/bin/busy-bar install
   ```

此功能无需 ADSBao API key。
服务会过滤过期或精度不足的定位、过期飞机位置，以及地面飞机。
详细设置与去重规则见[飞机功能说明](apps/src/busybar_apps/adsbao/README.md)。

## 启用通知

1. 阅读每个 [notifier app](apps/README.md) 的 README，并安装所需工具。

2. 创建私有配置文件。

   ```sh
   ${EDITOR:-vi} ~/Library/Application\ Support/BusyBarAI/notifier.json
   ```

3. 为每个 app 添加一个键，例如 `{"github": {}, "terminal": {}}`。

4. 重启后台服务。

   ```sh
   .venv/bin/busy-bar install
   ```

在 `.venv/bin/busy-bar status` 中检查 `notifier` 键。
运行 `.venv/bin/busy-bar notify-demo` 可查看每种通知。请先停止服务。

## 多台 Mac 共用一个 Bar

使用 BTC 协调多台 Mac。
每台 Mac 使用自己的电脑凭据和注册服务。
配对后的浏览器只能修改对应电脑的服务。
所有电脑共用三个全局优先级组。
Mac 迁入 cloud 模式后，不再运行 standalone 写屏服务。
具体步骤见[接入与迁移指南](docs/cloud-mode.zh-CN.md)。

standalone 模式使用另一套设备存储租约。
它让同一时刻只有一条通知占用显示。
紧急通知可以打断较低级别通知。
这套租约不提供 BTC 队列或三个全局组。

## 检查或停止服务

| 操作 | 命令 |
|---|---|
| 检查 standalone 组件 | `.venv/bin/busy-bar status` |
| 查看飞机诊断 | `.venv/bin/busy-bar adsbao-status` |
| 使用静态显示 | `.venv/bin/busy-bar install --reduced-motion` |
| 恢复动画 | `.venv/bin/busy-bar install` |
| 停止服务 | `.venv/bin/busy-bar uninstall` |

cloud 模式用 `.venv/bin/busy-bar status --mode cloud` 检查状态。
用 `.venv/bin/busy-bar install --mode cloud` 重启。
需要静态显示时，加 `--reduced-motion`。

standalone 模式检查 `service_running` 和 `button_input.connected`。
飞机诊断使用 `adsbao-status`。
状态输出包含连接情况和定位精度。
日志路径为 `~/Library/Logs/BusyBarAI/service.log`。
停止并卸载后台服务后，钥匙串凭据仍会保留。

## 更新当前仓库

在 main 分支的本地仓库中执行下列步骤。
普通更新保留原电脑身份、来源路由和凭据。
不要重新接入电脑。

1. 停止观察服务。

   ```sh
   .venv/bin/busy-bar uninstall
   ```

2. 获取当前 main，不重写本地提交。

   ```sh
   git pull --ff-only
   ```

3. 更新软件包。

   ```sh
   .venv/bin/python -m pip install -e .
   ```

4. 运行 Python 检查。

   ```sh
   .venv/bin/python scripts/run-tests.py
   ```

5. 使用原模式启动观察服务。

   | 原模式 | 命令 |
   |---|---|
   | Cloud | `.venv/bin/busy-bar install --mode cloud` |
   | Standalone | `.venv/bin/busy-bar install` |

## 演示模拟航班

此步骤使用 standalone 模式，向设备发送模拟内容。
cloud 写屏服务运行时，不要同时运行直连设备演示。

1. 停止后台服务。

   ```sh
   .venv/bin/busy-bar uninstall
   ```

2. 播放一次飞机演示。

   ```sh
   .venv/bin/busy-bar adsbao-demo
   ```

3. 重新启动后台服务。

   ```sh
   .venv/bin/busy-bar install
   ```

设备背屏会以 `DEMO` 标记演示。
如需生成无需连接设备的预览，执行下列命令：

```sh
.venv/bin/busy-bar adsbao-preview --output .local/aircraft-preview
```

## 数据与凭据

服务读取本机 agent 事件元数据。
BUSY 云端请求包含显示图像、动画和设备命令。
飞机数据连接会向 ADSBao 发送舍入后的坐标。
精确定位保存在本机私有文件中。

| 数据 | 保存位置 |
|---|---|
| 云端 token | 钥匙串服务 `app.busybar.ai-status`。 |
| 本地按键 token | 钥匙串服务 `app.busybar.local-input`。 |
| 定位、配置和事件元数据 | `~/Library/Application Support/BusyBarAI`。 |
| 后台服务注册 | `~/Library/LaunchAgents/app.busybar.ai-status.plist`。 |

运行时目录权限为 `0700`。
私有状态文件权限为 `0600`。
请勿将 token 或运行时文件提交到 Git。
standalone 模式使用 `ai-status` 显示命名空间。
cloud 模式使用 `busy-control`。
各模式只清理自己的命名空间。
来源账号的凭据保留在 Mac。
云端后端加密保存 BUSY 设备 token。
设备专注模式保留更高的优先级。

## 开发

| 目录 | 用途 |
|---|---|
| `shared` | 设备 API、钥匙串、按键、显示租约、文字和动画组件。 |
| `agent-checker` | Agent 任务登记、事件暂存、状态界面和过渡动画。 |
| `notifier` | 通知队列、后台来源、入场动画和显示控制。 |
| `apps` | Agent app 与 notifier app。 |
| `service` | 命令行、launchd 服务和云端发布者。 |
| `control-plane` | Cloudflare 调度、设备下发、管理 UI 和模拟后端。 |
| `scripts` | 原生助手构建、测试和预览。 |
| `docs` | 设计记录与设备截图。 |

运行全部测试：

```sh
.venv/bin/python scripts/run-tests.py
```

CI 使用 Python 3.10 和 3.14 运行测试。
修改代码时，添加有针对性的测试，并在提交拉取请求前运行全部测试。
预览和设备演示须明确标记模拟数据。

更多资料见 [agent checker](agent-checker/README.md)、[notifier](notifier/README.md)、[app](apps/README.md)、[共享组件](shared/README.md)和[动效验证](docs/weighted-motion.md)。

## 资料来源

- [BUSY HTTP API](https://docs.busy.app/bar/dev/http-api)。
- [原生字体来源与许可证](shared/src/busybar_shared/assets/font-source.txt)。
- [图标说明](apps/src/busybar_apps/NOTICE.md)。
- 英文写作原则：[ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/)。

中文说明沿用英文版的短句、明确术语和单步操作结构。
本项目独立于 BUSY、OpenAI 和 ADSBao。

## 游戏指示器

[游戏接入说明](apps/src/busybar_apps/gaming/README.zh-CN.md)可注册 WOW、WOW FOREVER 和 MAPLESTORY 三个独立服务，默认位于 Dispensable 组。打开对应客户端后，粗字从 **GAMING** 切换为英文游戏名，下方显示本次已打开时长。关闭客户端后撤回状态。同组服务按 Hold 轮换。
