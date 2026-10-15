# 控制面的本地客户端

[English](cloud-mode.md)

Cloud 模式把本地 agent 状态和通知发给控制面。控制面负责设备显示、队列、分组、稍后提醒和返回日历。来源工具及其凭据保留在 Mac。默认模式仍是 `standalone`。

共享云端预览仅接收模拟数据。真实采集器应使用你自己的生产 origin。模拟后端验收不能证明实体设备的显示效果。下面的步骤不包括生产部署或设备迁移。

## 1. 准备客户端

在仓库根目录使用项目虚拟环境：

```sh
.venv/bin/python -m pip install -e .
swiftc scripts/cloud-keychain.swift -o .venv/bin/busy-cloud-keychain
```

只需编译一次此 helper；Swift 源码改变后再编译。该步骤不重编译现有设备 token、输入 token 或定位 helper。Keychain 条目如下：

| 角色 | Keychain service | Account |
| --- | --- | --- |
| Agent | `app.busybar.control-plane.agent` | `busy-bar` |
| Notifier | `app.busybar.control-plane.notifier` | `busy-bar` |

## 2. 创建服务

打开控制面页面，分别添加一个 **agent** 服务和一个 **notifier** 服务。Notifier 的优先级应高于 agent。页面默认值分别为 agent 10、notifier 50。通常保留默认退出策略。

复制页面分别显示的 publisher credential。每份凭据只属于一个服务，页面仅显示一次。不要把它放入 shell 命令、环境变量、仓库文件或聊天。

## 3. 配置本地角色

本地模拟环境使用：

```sh
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role agent --instance mac-agent
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role notifier --instance mac-notifier
```

连接已托管的控制面时，替换为其 HTTPS origin：

```sh
.venv/bin/busy-bar cloud-setup --url https://YOUR-CONTROL-PLANE.example --role agent --instance mac-agent
.venv/bin/busy-bar cloud-setup --url https://YOUR-CONTROL-PLANE.example --role notifier --instance mac-notifier
```

在隐藏输入提示中粘贴对应角色的凭据。Setup 会读取受限 snapshot 验证身份，把秘密保存到 Keychain，仅把非秘密服务元数据写入私有文件。它不改变已安装服务，也不向设备发请求。

`--instance` 可省略；省略时保留原名称或生成稳定名称。重启后保留 instance 和签发的 epoch。可只配置一个角色；两个角色都配置后会同时运行两个采集器。

本地 urgent 兜底默认等待 10 秒。每个角色都可以设置 1 到 300 的整数秒数：

```sh
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role notifier --fallback-seconds 17
```

该值作为非秘密 `fallbackSeconds` 元数据保存，重启后仍然有效。旧元数据没有该字段时使用 10 秒。修改配置不会重置现有 occurrence 的期限。

URL 必须是 origin，不能含路径、用户信息、query 或 fragment；禁止重定向。只有 loopback 本地开发地址可以使用 HTTP。

## 4. 前台运行

原 observer 和 cloud observer 共用进程锁。先停止原 observer，再运行 cloud watch。对于已经安装 standalone 服务的机器，可先删除其 launchd 注册；凭据会保留：

```sh
.venv/bin/busy-bar uninstall
.venv/bin/busy-bar watch --mode cloud
```

按 Control-C 停止。停止后保留 occurrence ID、snooze、操作结果和 urgent 期限。短时间内重启会续期相同 occurrence。若后端租约先过期，则遵循后端 tombstone，直到来源确认 clear 或出现新 agent turn 才允许再次出现。客户端不清理设备 namespace。

在另一个终端查看 cloud 状态：

```sh
.venv/bin/busy-bar status --mode cloud
```

它读取控制面，不需要 BUSY 设备 token；每个结果仅含该角色服务有权读取的内容。即使后端不可达，也会显示本地 OS 通知最近一次和最多八次结果。`submitted` 仅表示通知进程接受请求，不证明已获得通知权限或用户已经收到。

减少动画可用：

```sh
.venv/bin/busy-bar watch --mode cloud --reduced-motion
```

## 5. 就绪后再安装

前台测试不会安装 cloud 模式。确定要开机登录后启动时，显式执行：

```sh
.venv/bin/busy-bar install --mode cloud
```

该命令复用原用户级 launchd label，替换安装的 watch 命令。它验证 cloud 元数据，不读取设备 token、不编译 helper、不改变来源凭据。Observer 启动后才检查 Keychain 读取权限。

以后恢复 standalone 模式时，先停止 cloud watch，再执行：

```sh
.venv/bin/busy-bar install --mode standalone
```

Standalone 需要原有 BUSY 设备 token。

## 输入和本地操作

Cloud watch 可以读取已配置的 Wi-Fi 输入。如有需要，先在 standalone 模式配置它。Cloud watch 不执行输入配置，也不使用默认 USB endpoint。在控制面服务设置中，仅为一个本地监听者启用 **Allow input**。它的 service 和 instance 可以与当前显示所有者不同。Start/Pause 会向 `/api/input` 发送稳定 event ID 和当前 generation，由后端决定执行 urgent 主操作或清理当前非 urgent 项。

主操作回调在提供该回调的 Mac 上执行。例如 Datadog 回调使用本地 `pup`。执行器核对 service、instance、item、generation 和已声明的 action key，并在产生副作用前保存 action ID。执行中断后，重启会标记 **unknown**，不会自动重试副作用。Running 和终态结果保留在 durable outbox，直到发送完成。不可用的回调报告失败，不会报告假成功。

## 投递和 urgent 兜底

Notifier 发布所有来源的原始项。State 来源对应 condition，event 来源对应 event；保留原来源 group key，分组范围限定在 notifier 服务内。飞机使用持久化 encounter ID：重复轮询和重启保留同一 ID；确认在外圈离开到达重置条件或每日重置后，才生成新 ID。后端负责排序和 snooze。手动 clear 会封存 occurrence，heartbeat 不会复活它。投递过期同样禁止 cloud 重放，但本地仍未解决的 urgent 项会保留兜底文字和期限，直到来源确认 clear 或执行兜底通知。来源确认条件已清除、以后再次出现时，才创建新的 occurrence UUID。

来源轮询失败时保留最后条件并标记为不确定，停止续期。成功轮询的有效窗口有界，并考虑下一次预定轮询时间。卡住的来源不能无限续期缓存。仅在 cloud 确认接纳显示后调用来源 `on_shown`。

客户端复用现有 native renderer。通知场景包括完整入场、0.3 秒时出现的 detail 和最终画面。动画按内容哈希以 `anim` 类型上传。超出单元素大小限制的背屏 bitmap 无损转为 PNG 资产。Agent 的时钟和网络更新使用 native update，并保留完整恢复场景。

Urgent watchdog 独立于 HTTP、SSE 和来源轮询运行。默认从本地首次识别起计时 10 秒。匹配的设备确认、有效 queue proof，或精确匹配已接纳成员版本的 coverage proof，可以推迟本地 macOS 通知。证明有效期有限，重复快照不会重置失败期限。证明过期或所有者退出后，最多再过一个配置的等待周期触发兜底，默认 10 秒。Pause 和 disable 会抑制兜底。首次识别时间、期限和通知去重状态在重启后保留。运行时采用单调时钟，并持久化其 UTC 映射；系统时钟回拨不会重置期限。Mac 睡眠后还会使用当前 UTC 推进有效时间，防止过期证明跨睡眠继续有效。设备确认只代表 API 写入被确认，不代表实体像素验收。

## 排错

- **Keychain unavailable：**解锁 Keychain，授权已编译的 helper，然后重启。后台读取失败时不会弹出权限提示。
- **Setup required：**对缺失角色重新运行 `cloud-setup`。管理员重发凭据后使用新凭据；新的 epoch 开始新的本地 producer session。
- **Unauthorized：**检查角色凭据。Producer 停止认证重试，不会回退到设备直写。
- **Observer already running：**停止原 observer，两种模式共用 `watch.lock`。
- **Waiting：**检查 cloud status 和队列页面。另一个 urgent 项可能占有显示，而当前项有有效等待证明。
- **Source error：**检查本地来源工具。Cloud 模式不会把来源凭据复制到控制面。

本地元数据和 durable outbox 位于现有 `~/Library/Application Support/BusyBarAI` 目录。文件权限为 0600，可能包含通知文字，但不含 publisher credential。不要通过删除这些文件来重试操作或绕过手动 clear。

本地保留量有明确上限：128 个缓存资产或 8 MiB、4096 个 occurrence 或待发送 end ID、512 个 action ID、2048 个待发送 input ID，以及 32 MiB 总状态。无引用资产按 LRU 回收。结束项会压缩显示内容，但保留防重放和操作去重 ID。达到容量上限会明确报错，不会静默丢弃待处理工作。
