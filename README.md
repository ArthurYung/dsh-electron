# DeepSeek API Harness

本项目使用 DeepSeek Harness 提供本地 Web Agent，默认调用官方 DeepSeek API，不再随 Harness 启动本地 Qwen 模型。

- Provider：`deepseek-official`
- Model：`deepseek-v4-flash`
- API：`https://api.deepseek.com`
- Harness 页面：`http://127.0.0.1:3080`

## Electron 桌面端

免安装桌面程序位于：

```text
dist-electron\win-unpacked\DeepSeek Harness.exe
```

桌面端会自动启动 Harness、等待服务就绪并在应用窗口内打开页面。关闭桌面窗口时，只会停止由该桌面端启动的 Harness；如果 `3080` 已经存在可用的 Harness，它会安全复用且不会在退出时误杀。

桌面版固定使用 Harness 的页面内目录浏览器选择工作区，避免后台 Win32 文件夹对话框被 Electron 窗口遮挡。点击路径栏的编辑按钮后可以直接输入任意绝对路径，例如 `E:\bruce\project`。

开发启动：

```powershell
npm run desktop
```

生成免安装目录或 Windows 安装包：

```powershell
npm run desktop:pack
npm run desktop:build
```

安装版配置保存在 `%APPDATA%\DeepSeek Harness\harness`，工作目录默认为“文档\DeepSeek Harness Workspace”。API Token 只写入用户数据目录，不会进入安装包。

## 启动和设置 Token

双击 `start-agent.cmd`，或在 PowerShell 中执行：

```powershell
.\start-agent.cmd
```

打开 `http://127.0.0.1:3080`，进入 **设置 → 模型**，在 DeepSeek 配置中填写自己的 API Key 并保存。Token 由 Harness 本地凭据服务管理，不要写进项目文件或提交到版本库。

停止服务：

```powershell
.\stop-agent.cmd
```

启动器是纯 Node 实现，不依赖 Python。端口 `8000` 的本地模型服务不会自动启动，也不会加载 GGUF 或占用本地显存。

## Agent 工具

`local-tools` 预设为 DeepSeek 提供：

- 工作区文件读取、创建、编辑和搜索；
- PowerShell 命令与测试执行；
- 多步骤任务清单；
- Harness 自带的 DeepSeek Web Search；
- Windows Computer Use。

Computer Use 包含两个原生 Harness 工具：

- `computer_observe`：读取前台窗口或指定标题窗口的 Windows UI Automation 控件树，可选保存本地截图；
- `computer_action`：点击、双击、移动、输入文字、按键和滚轮操作。

每次界面动作前必须先观察，动作后必须重新观察验证。控件 `ref` 只对当前会话的最新一次观察有效。所有 `computer_action` 调用都会进入 Harness 审批流程；终端、Windows Run、登录/验证、密码管理器、Windows 安全界面和 Windows 键组合由插件强制拦截。

官方 DeepSeek chat-completions 路由当前按文本输入使用，因此截图只保存在本机，模型主要读取 UI Automation 的结构化文本。画布、游戏、远程桌面等缺少可访问性控件的纯视觉界面仍需要额外视觉模型。

修改预设或工具插件后，请刷新页面并新建会话；已有输出的旧会话不会热切换预设。

## 关键位置

- Harness 默认模型：`.dsh/settings.yaml`
- Agent Prompt 与插件装配：`.dsh/.agent-presets/local-tools/agent.cordis.yml`
- Computer Use 插件：`.dsh/.agent-presets/local-tools/computer-use/`
- Harness 日志：`.dsh/logs/`
- Harness 本地凭据：`.dsh/.credentials.yaml`

运行测试：

```powershell
npm test
```

## 可选：手动运行保留的本地模型

原来的本地 Qwen 代码和模型文件没有删除，但已与 Harness 启动流程分离。只有手动运行对应命令时才会加载本地模型。
