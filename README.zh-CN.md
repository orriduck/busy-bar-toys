# busy-bar-toys

[English](README.md) | 简体中文

在 BUSY Bar 上显示本机 Codex 任务状态和附近飞机。
一个后台服务运行两个小工具。
设备原生日历是默认界面。

![使用模拟航班数据的动画预览](docs/images/staggered-flight-preview.gif)

此预览使用模拟航班数据。
可对照查看[设备实测截图](docs/images/actual-staggered-intro.png)。

## 小工具

| 小工具 | 显示内容 |
|---|---|
| [Codex checker](agent-checker/README.md) | 任务状态、ChatGPT 或 Your dot 图标、时钟、网络速度。 |
| [ADSBao checker](apps/src/busybar_apps/adsbao/README.md) | 飞机进入三英里范围时的临时提示。 |

### Codex 状态

开始一个本机 Codex 任务，即可显示状态界面。
时钟使用纽约时区和 24 小时制。
彩色箭头表示上传和下载是否活跃。
数字表示 Mac 默认网络接口的上下行总速度。

| 光条 | 状态 |
|---|---|
| 上下移动的蓝条 | 任务正在运行。 |
| 黄条 | 任务需要输入或批准。 |
| 细白条 | 任务已完成或停止。 |
| 红条 | 任务报告错误。 |
| 灰条 | 任务超过 30 分钟没有更新。 |

待机十秒后，服务恢复原生日历。
按 Start/Pause 可立即恢复日历。
下一轮任务开始时，服务重新显示 Codex。

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
服务再恢复当前 Codex 界面或原生日历。
同一架飞机在一次经过期间只提示一次。

## 环境要求

- macOS，以及 Python 3.10 或更新版本。
- 包含 `swiftc` 和 `xcrun` 的 Apple 命令行工具。
- 已连接互联网的 BUSY Bar，以及适用于该设备的云端 API token。
- 供 Start/Pause 使用的 Wi-Fi 或 USB 本地连接。

保持 Mac 唤醒并连接互联网。
Wi-Fi 按键功能要求 Mac 与 Bar 在局域网内互通。
只要网络允许互通，两台设备可以使用不同的 Wi-Fi 频段。

## 安装

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
按 Start/Pause 可关闭任一小工具的界面，并显示日历。

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

## 检查或停止服务

| 操作 | 命令 |
|---|---|
| 检查全部组件 | `.venv/bin/busy-bar status` |
| 查看飞机诊断 | `.venv/bin/busy-bar adsbao-status` |
| 使用静态显示 | `.venv/bin/busy-bar install --reduced-motion` |
| 恢复动画 | `.venv/bin/busy-bar install` |
| 停止服务 | `.venv/bin/busy-bar uninstall` |

按已启用的功能，检查 `service_running`、`traffic.connected` 和 `button_input.connected`。
状态输出包含连接情况和定位精度。
日志路径为 `~/Library/Logs/BusyBarAI/service.log`。
停止并卸载后台服务后，钥匙串凭据仍会保留。

## 演示模拟航班

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

服务读取本机 Codex 事件元数据。
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
服务仅清理自己的 `ai-status` 显示命名空间。
设备专注模式保留更高的优先级。

## 开发

| 目录 | 用途 |
|---|---|
| `codex-checker` | Codex 事件、显示状态、时钟和网络速度。 |
| `adsbao-checker` | 定位、飞机数据、经过判断和飞机界面。 |
| `shared` | 设备 API、钥匙串、按键、文字和动画组件。 |
| `scripts` | 原生助手构建、测试和预览。 |
| `docs` | 设计记录与设备截图。 |

运行全部测试：

```sh
.venv/bin/python scripts/run-tests.py
```

CI 使用 Python 3.10 和 3.14 运行测试。
修改代码时，添加有针对性的测试，并在提交拉取请求前运行全部测试。
预览和设备演示须明确标记模拟数据。

更多资料见 [Codex 事件与 hooks](agent-checker/README.md)、[共享组件](shared/README.md)和[动效验证](docs/weighted-motion.md)。

## 资料来源

- [BUSY HTTP API](https://docs.busy.app/bar/dev/http-api)。
- [原生字体来源与许可证](shared/src/busybar_shared/assets/font-source.txt)。
- [图标说明](agent-checker/src/busybar_agents/assets/NOTICE.md)。
- 英文写作原则：[ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/)。

中文说明沿用英文版的短句、明确术语和单步操作结构。
本项目独立于 BUSY、OpenAI 和 ADSBao。
