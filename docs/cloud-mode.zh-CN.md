# 将 Mac 接入 BTC

[English](cloud-mode.md)

打开 [BTC](https://btc.orriduck.workers.dev)。云端后端控制 Bar；Mac 采集本地状态，向注册的服务 ID 发送内容。设备 API key 用于查看全部电脑。配对后，浏览器只能管理对应电脑名下的服务。

## 准备客户端

在仓库根目录运行：

```sh
.venv/bin/python -m pip install -e .
swiftc scripts/cloud-keychain.swift -o .venv/bin/busy-cloud-keychain
```

电脑凭据保存在钥匙串 `app.busybar.control-plane.computer`，账户为 `busy-bar`。`~/Library/Application Support/BusyBarAI/cloud-computer.json` 只保存 ID、epoch 和本地路由。保持目录私有。不要把凭据或注册票据放进命令参数、Git 或聊天。

## 接入新电脑

1. 用设备 API key 登录，打开 **Services → Connect computer**。
2. 创建有效期五分钟的 enrollment ticket。
3. 运行下列命令，在隐藏输入框粘贴票据。

```sh
.venv/bin/busy-bar cloud-enroll --url https://btc.orriduck.workers.dev
```

客户端先保存电脑凭据，再提交注册。若回复丢失，可使用同一票据重试。客户端先检查已保存的凭据，不会另建电脑身份。

只注册这台电脑实际使用的来源：

```sh
.venv/bin/busy-bar cloud-register codex --name Codex --template agent
.venv/bin/busy-bar cloud-register adsbao --name ADSBao --source adsbao
```

GitHub、Datadog 等来源可以分别注册。这些命令不会启用或配置外部工具：

```sh
.venv/bin/busy-bar cloud-register github --name GitHub --source github
.venv/bin/busy-bar cloud-register datadog --name Datadog --source datadog
```

`--source` 使用采集器实际的本地来源名。命令会输出服务 ID。也可以把来源指向这台电脑名下的任意现有服务：

```sh
.venv/bin/busy-bar cloud-route SOURCE SERVICE_ID
```

Notifier 是通用发送引擎。同一电脑凭据可以向本机名下任意注册 ID 发送任意应用标签和内容。后端只校验归属，不规定应用与服务的对应关系。对应关系由 Mac 决定。更改注册或路由后重启采集服务。没有路由的来源不会启动，并会报告设置提示。

## 配对浏览器

```sh
.venv/bin/busy-bar cloud-pair
```

把五分钟有效的一次性代码粘贴到 **Connect computer → Pairing code**。绑定记录保存在服务端；浏览器偏好不能赋予权限。需要管理另一台电脑时，先退出登录。退出不会停止 Mac 上的采集服务。

**Configuration** 按三个全局组展示全部电脑的服务。只能把本机服务拖到其他组。同组服务同级，行序不影响调度；其他电脑可查看、不可拖动。

- **Interception**：立即打断下面两个组，适合需要马上显示的 Page。
- **Follow queue**：按队列播放，同组新消息不打断当前消息。同组按消息到达顺序排队，新消息不打断当前同组消息。源端结束型消息需要宿主主动结束，队列才会继续。
- **Dispensable**：前两个组空闲时显示后台状态。全部可用服务按各自的 Hold 轮流展示，同一台电脑上的服务也参与轮换。

服务所属组决定全局优先级，电脑归属及列表位置都不会形成组内层级。高组打断后保留原消息及剩余时间；发送端的 urgent 不能越过注册服务所属的组。Hold 仅计入入场结束后经设备确认的可见时间。源状态轮转时不会结束，定时消息仍按原有累计时长结束。Services 和 Configuration 展示来源连接、最近心跳、分组、当前展示与排队数；未汇报过的来源不会显示成已连接。

发送端逐条声明 `exit: finite|source`。Hold 控制 Dispensable 的可见轮次，以及定时消息的累计展示寿命。宿主决定什么时候再发送新消息。注册 API 可显式指定 `priorityGroup`，也可在 Configuration 中拖动本机服务；新 Agent 默认进入 Dispensable，其他模板默认进入 Follow queue。

## 升级已接入的 Mac

旧 Agent、Notifier 凭据仍可发送消息，但不能管理配置。只升级当前这台电脑：

```sh
.venv/bin/busy-bar uninstall
.venv/bin/busy-bar cloud-migrate --url https://btc.orriduck.workers.dev
.venv/bin/busy-bar cloud-register codex --name Codex --template agent
.venv/bin/busy-bar cloud-register adsbao --name ADSBao --source adsbao
.venv/bin/busy-bar cloud-handover
```

迁移要求持有该电脑全部旧服务的凭据。电脑 ID 和采集实例 ID 保持稳定，新服务使用新 ID。交接时采集服务必须停止。旧私有文件会保留。已结束记录、事件 ID 和更早的紧急通知截止时间会保留。旧服务的云端确认凭证会丢弃，不能继续推迟本地兜底通知。

尚未显示的事件会保留完整画面，并等待一次成功的来源轮询；已显示事件不会重播。持续状态等待重新采样。动作回调不能跨进程迁移，因此复制的事件不会提供旧动作按钮。未解决的本地动作会阻止交接。保留来源游标和 ADSBao 飞机去重记录，不要删除它们来强制重播。

新服务工作正常后，只删除本机已退役的注册。若云端动作仍为 pending、running 或 unknown，后端会拒绝删除。其他 Mac 需各自迁移。

## 运行与验证

```sh
.venv/bin/busy-bar watch --mode cloud
.venv/bin/busy-bar status --mode cloud
```

前台与后台采集共用进程锁，不能同时运行。status 读取各注册服务的独立范围及本地诊断。系统通知的 `submitted` 只说明进程已接受请求，不代表用户已经收到。

验证后设置登录自启：

```sh
.venv/bin/busy-bar install --mode cloud
```

此命令替换现有的用户 launchd 启动项，不安装 Claude hook。Codex 继续由现有本地采集器观察。Start/Pause 和实时预览仍需要对应服务开关及局域网连接。

本地开发使用隔离 mock 环境。不要向 mock 输入真实设备 key。模拟测试不能证明实体屏幕表现。


## Agent status and input requests

Register a separate Notifier before starting an upgraded observer:

```sh
.venv/bin/busy-bar cloud-register agent-notifier --template notifier --name "Agent requests" --source agent-notifier
```

在网页中把 Agent requests、ADSBao 放入 Follow queue，把 Agent 状态放入 Dispensable；需要立即打断的独立 Page 服务放入 Interception。各组只调整本机服务的队列。日常状态与输入请求使用两个注册服务；每个等待任务都有独立消息。问题解决后源端撤下提示，工作状态继续。其他电脑也须单独注册和路由自己的 Notifier；此命令不改动其他电脑。

撤回通知：调用 `CloudQueue.withdraw(source, item_id)` 或 `RoutedCloudQueue.withdraw(source, item_id)`。本地 outbox 持久重试 `POST /api/withdraw`，成功后才删除待发送记录。HTTP 字段为 `instanceId`、`epoch`、`itemId`、`version`，使用对应 owned service 的发布身份。撤回会终止当前 occurrence；下一次发送须创建新 occurrence。


## 恢复断开的预览

遇到已知的过期帧、限流或序号拒收时，本机桥按 1–30 秒退避重连。每次重连创建新流，并重新核对设备身份。认证、设备身份和未知协议错误仍会停止桥接。

检查 `~/Library/Application Support/BusyBarAI/preview-status.json`。`lastCloudError` 只记录已知的服务器错误码。通过 `connected`、`sent` 和 `timestamp` 判断当前是否持续发送画面。旧版留下的 `protocol` 状态无法说明最初触发原因；重启本机服务前保留该报告，供后续排查。
