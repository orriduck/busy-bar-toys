# 游戏状态

游戏客户端打开时显示状态。粗字从 **GAMING** 切换为 **WOW**、**WOW FOREVER** 或 **MAPLESTORY**。下方显示本次客户端已打开多久。这不是 AFK 检测，也不代表角色已进入游戏。

三个游戏各有一个注册服务。新服务使用 **Dispensable** 组。同组服务按 Hold 轮换。高组别通知可以打断游戏显示。关闭客户端后撤回该状态。

## 接入这台 Mac

先将 Mac 注册到控制平面。沿用已有电脑 ID。

```bash
.venv/bin/pip install -e .
.venv/bin/busy-bar gaming-setup
.venv/bin/busy-bar install --mode cloud
.venv/bin/busy-bar gaming-status
```

命令会编译本地 AppKit 检测程序，并创建三个本机服务。中断后可再次运行；原有服务 ID 会保留。它不会更改另一台电脑的服务，也不会重置你之后在 Configuration 中调整的组别。

只检测实际游戏客户端。Battle.net 和 MapleStory Launcher 不计入。WOW 对应 `_retail_` 客户端；WOW FOREVER 对应 `_classic_beta_` 客户端。两者 bundle ID 相同，因此还要核对客户端路径。支持的冒险岛客户端 bundle ID 为 `com.nexon.maplestoryna_exe`。

切到后台和电脑休眠时继续计时。重新打开游戏会开始新会话。检测服务重启后，只在客户端仍运行时恢复该会话。检测失败会标为未知，不会伪造退出或重开。

检测程序只读取 App 启动信息，不读取游戏内存、截图、角色名或键盘输入。App 路径和进程清单留在本机。云端只接收游戏名与时长。

## 共用活动层

`ActivityPublisher` 为 Agent 和游戏共用会话标识、待发显示更新、源状态和撤回逻辑。Agent 任务检测、Token 速率、Notifier 请求、网络传输和全局调度保留各自职责。

粗字切换复用已有逐字动画。时间从首帧显示，后续只更新计时行，不重播标题动画或重置滚动。完整场景用于恢复和 Hold 轮换。

设备和管理页使用游戏官网图标。设备按比例缩小图标，不拉伸。来源见[素材说明](../NOTICE.md)。

## 离线预览

此预览使用模拟时长渲染，不是实际游戏或设备录像。

![游戏状态离线模拟预览](../../../../docs/images/gaming-rendered-mock.gif)
