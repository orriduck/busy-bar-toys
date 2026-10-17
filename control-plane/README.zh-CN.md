# BUSY Traffic Control

[English](README.md) · [协议](PROTOCOL.md) · [Mac 接入](../docs/cloud-mode.zh-CN.md)

在 [btc.orriduck.workers.dev](https://btc.orriduck.workers.dev) 管理 BUSY Bar。
Cloudflare 后端选择内容并写屏。
每台 Mac 采集本机事件，向自己的注册服务发送画面。
关闭浏览器不会停止云端调度。

界面使用 React、Vite、Tailwind，以及基于 Base UI 的 shadcn/ui。
TanStack Query 管理服务端状态。
GSAP 处理列表和页面过渡，Number Flow 处理数字变化。

## 查看页面

| 页面 | 用途 |
|---|---|
| **Display** | 真实正面像素、当前消息和等待队列。 |
| **Services** | 服务卡片、来源接入、开关和连接详情。 |
| **Configuration** | 三个全局组、Hold 和 Heartbeat。 |
| **Device** | 设备连接、当前控制者、API 确认和预览诊断。 |

队列先显示已经确认播放的消息。
其他行保持服务端顺序。
细进度条标记当前消息。
轮播条按服务显示，不因同一服务有多条消息而重复。
新消息平滑进入，移除的消息淡出。
展开一行，可查看正文、完整来源 ID、接收时间和可用操作。

Sender 的短 ID 表示发送电脑。
它不是通知中的业务作者。
Received 精确到秒，消息更新后仍保留首次接收时间。
被选中的消息不一定已在设备上显示。
API 确认不能单独证明实体像素。

其他页面保留紧凑的实时预览。
移动端使用悬浮的图标导航栏。
主题按钮依次切换 Automatic、Light 和 Dark。
可以把 BTC 作为 PWA 添加到主屏幕。
PWA 仍需联网才能控制设备和读取实时数据。

<details>
<summary>当前界面：本地模拟数据</summary>

这些截图使用模拟服务和模拟设备。
它们不证明真实设备已经连接。

![队列插入、打断、轮播和移除](../docs/images/control-plane-queue.gif)

| Configuration | Services |
|---|---|
| ![本地模拟配置页](../docs/images/control-plane-config.png) | ![本地模拟服务页](../docs/images/control-plane-services.png) |

</details>

## 接入 Mac

1. 使用适用于设备的 BUSY API token 登录。
2. 打开 **Services → Connect computer**。
3. 按[客户端指南](../docs/cloud-mode.zh-CN.md)接入。
4. 注册 Agent status 和独立的 Agent requests Notifier。
5. 将此浏览器与电脑配对。
6. 使用 `--mode cloud` 启动观察服务。

设备 token 允许查看所有电脑。
服务端浏览器配对允许修改一台电脑的服务。
其他电脑始终可见，但只能读取。
浏览器本地偏好不能授予编辑权限。

接入指南包含电脑接入、可选来源、路由和迁移。
只用 Codex 的 Mac 不需要 Claude hooks。
注册服务不会启动采集器，也不会上传可执行代码。
自定义发布者使用 [PROTOCOL.md](PROTOCOL.md)。

## 添加和控制服务

1. 打开 **Services**。
2. 选择 **Add service**。
3. 选择 **Agent status**、**Notifications** 或 **Your own app**。
4. 输入名称。
5. 选择 **Add service**。
6. 按来源连接引导操作。

表单会生成服务 ID。
高级设置允许自定义 ID。
来源引导提供 `busy-bar cloud-route SOURCE SERVICE_ID`。
如果 PATH 中没有 `busy-bar`，在仓库根目录使用 `.venv/bin/busy-bar`。

在已配对 Mac 上使用安装好的客户端执行此命令。
然后重启该 Mac 的 cloud 观察服务。
只创建服务，不会连接来源。

主开关控制服务启用或停用。
展开 **Connection**，查看心跳、ID、**Bar buttons** 和 **Live preview**。
仅向实际提供桥接的服务授予按键或预览能力。
撤销、移除和替换凭据是不同操作。
替换凭据会结束该服务的旧项目。
更新本地连接后，服务才能再次发布。

## 设置全局组

| 组 | 行为 |
|---|---|
| **Interception** | 打断较低组，保留被打断的消息。 |
| **Follow queue** | 按到达顺序播放，被打断后继续。 |
| **Dispensable** | 上方两组为空时运行，各服务按 Hold 轮换。 |

分组优先级适用于所有电脑。
同组服务同级。
行序不会增加优先级。
只能移动本机服务换组。
可以拖拽，也可以使用移动菜单或键盘。
换组立即保存。

选择服务后编辑时间设置。
桌面端并排显示分组列表和详情。
移动端分别显示列表与详情。
完整 ID 保留在 **Connection details** 中。

| 设置 | 含义 |
|---|---|
| **Hold** | 后台服务的可见轮播时长，以及定时消息的累计可见时长。 |
| **Heartbeat** | 服务允许的上报间隔。 |

使用吸附滑动条，或直接编辑数值。
选择 **Save changes** 保存时间设置。
选择 **Discard** 丢弃未保存的时间设置。
如果服务端拒绝旧配置，先重新加载，再重试。

每条消息由发送端声明 `exit: finite` 或 `exit: source`。
定时消息从入场结束后计时，被打断时暂停。
由来源结束的消息，需要宿主结束或撤出。
宿主决定何时发送新的事件。
Configuration 不提供 Exit 或 Later 控件。

Agent 状态与批准、提问请求使用不同的注册服务。
状态放入 Dispensable，请求放入 Follow queue。
必须打断较低组的专用 Page 服务使用 Interception。

## 连接预览和按键

预览要求指定 Mac 与 Bar 在 Wi-Fi 局域网内互通。
在 Services 中，为该 Mac 的服务打开 **Live preview**。
预览桥先核对设备身份，再读取正面 framebuffer。
登录后的管理页可见时，桥会发送真实像素。

采集目标为 30 fps，Device 显示实测速率。
浏览器缓冲目标约为 150 毫秒，最多保留六个待播放帧。
预览桥不可用不会停止调度或设备写入。
参见[预览恢复](../docs/cloud-mode.zh-CN.md#恢复断开的预览)。

**Bar buttons** 允许指定监听器处理设备级 Start/Pause。
普通发布者不能清除其他服务的项目。
Primary 动作由原 Mac 执行。
失败或未知的动作结果不会结束通知。

当前紧急项目有 primary 动作时，Start/Pause 执行该动作。
否则清除非紧急项目，并请求恢复日历。
紧急项目不受这次清除影响。

## 试用模拟设备

[共享预览](https://busy-bar-control-plane-preview.orriduck.workers.dev)使用 `demo-token`。
只使用模拟数据。
不要向公开演示接入真实采集器或私有来源凭据。
预览使用独立存储和 secret bindings。
其模拟 BUSY Worker 不能控制真实设备。

本地演示使用 Node 26 和 npm。
从仓库根目录运行：

```sh
cd control-plane
npm ci
npm run dev:demo
```

1. 打开 `http://localhost:8787`。
2. 使用 `demo-token` 登录。
3. 打开 Display，查看模拟设备。
4. 打开另一个页面，检查 SSE 更新。

页面显示 **DEMO**，`/api/mode` 返回 `demo:true`。
使用 `demo-blocked` 或 `demo-offline` 测试拒绝显示或连接失败。
模拟 API 拒绝真实设备 token。
本地诊断状态位于 `http://localhost:8790/__demo/state`。
停止终端进程即可停止本地调度。
已忽略的 `.wrangler/` 文件保留本地状态。

## 运行检查

在 `control-plane` 中运行：

```sh
npm test
npm run typecheck
npm run build
npm run dry-run
```

测试使用 Workers 运行时、SQLite Durable Object 和模拟上游 HTTP。
Dry run 只打包 Worker，不会部署。

在仓库根目录运行 Python 测试：

```sh
.venv/bin/python scripts/run-tests.py
```

测试不能证明实体像素、生产可用性或双 Mac 迁移。
这些结果需要单独实机检查。

## 部署自己的后端

生产配置固定调用 BUSY cloud API。
不要部署演示配置或公开测试密钥。

1. 将 `PUBLIC_ORIGIN` 设为站点的准确 HTTPS origin。
2. 通过 Wrangler secrets 设置新的 64 字符十六进制 `TOKEN_ENCRYPTION_KEY`。
3. 单独设置随机 `SESSION_SIGNING_KEY`。
4. 运行 `npm run types`。
5. 运行上面的检查。
6. 将生产配置部署到自己的账号。
7. 先验证登录和调度，再迁移设备写入方。

`wrangler secret put NAME` 从标准输入读取值，并创建部署版本。
密钥不能进入命令参数、Git 或日志。

本项目正式站使用连接 Git 的 Cloudflare Workers Builds。
GitHub Actions 单独运行检查。
其他 Mac 需要各自迁移。
分批迁移时，不要撤销其他 Mac 仍在使用的 token。
参见[迁移指南](../docs/cloud-mode.zh-CN.md#升级已接入的-mac)。

## 存储与故障规则

后端核对设备身份，并使用 AES-GCM 加密 BUSY token。
浏览器会话使用 Secure、HttpOnly、SameSite cookie。
电脑凭据只能向该电脑拥有的服务发布。
旧 publisher 凭据只能向一个服务发布。
来源账号的凭据保留在 Mac。

SQLite 先保存队列状态和命令意图，再调用设备 HTTP。
每台设备只有一个顺序 dispatcher。
每次写入前，dispatcher 检查 generation。
Alarm 处理过期、重试和续期。
正常交接先准备下一画面，再移除旧元素。
冷启动恢复或未知设备状态可能需要完整清屏。
容量回退可能短暂显示黑屏。
参见[交接边界](../docs/seamless-handoff.md)。

数字滚动的末帧完全透明。
旧数字不能覆盖后续底图更新。
参见[数字覆盖层生命周期](../docs/digit-overlay-lifecycle.md)。

| 每台设备的资源 | 上限 |
|---|---|
| 注册服务 | 32 |
| 活动项目 / 画面 JSON | 256 / 2 MiB |
| 活动项与防重放保留位 | 4096 |
| 动作 / 按键 ID / 会话 / SSE 客户端 | 512 / 2048 / 64 / 16 |
| 云端素材 | 64 文件 / 4 MiB；单个 256 KiB |
| 设备素材 | 16 个固定文件名 / 2 MiB |
| 原生元素租约 | 最多六十秒 |

容量错误会明确返回。
后端不会覆盖正在播放的素材。
云端故障不会让 Mac 改为直写 Bar。
原生元素到期后，设备恢复日历。
原 Mac 的独立 watchdog 可以提供紧急系统通知。
休眠或未获通知权限时，这项兜底可能不可用。

退出登录会结束浏览器会话和配对。
它不会停止 Mac 观察服务或云端调度。
