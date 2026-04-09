# Sonic 设备集成设计

**日期:** 2026-04-09
**状态:** 已批准

---

## 背景

claude-in-mobile 是一个 MCP server + Rust CLI，通过本地 ADB/simctl 控制 Android/iOS 设备。

Sonic 是一套远程设备管理系统，包含：
- **Sonic Server** — 中心协调器，提供设备管理 REST API
- **Sonic Agent** — 运行在设备宿主机上的 Java Spring Boot 服务，通过 WebSocket 提供设备控制能力

本次设计目标：在不破坏现有接口的前提下，将 Sonic 设备接入 claude-in-mobile 的 MCP 工具和 CLI，让 AI agent 和用户能通过完全相同的工具/命令控制 Sonic 管理的真机。

---

## 核心设计决策

### 1. SONIC_ENABLE 模式开关（互斥而非叠加）

`SONIC_ENABLE=true` 时，Android/iOS 设备**全部**来自 Sonic，不再使用本地 ADB/simctl。Desktop、Aurora、Browser 不受影响，始终使用本地实现。

**原因：** 实际场景中要么在本地开发（本地设备），要么接入远程设备农场（Sonic）。混合模式增加复杂性但无实际收益，互斥语义更清晰。

### 2. Device 接口零侵入

不新增 platform 类型，不修改 `Device` 接口，不添加 `SonicDevice` 扩展类型。路由依据是全局模式标志（`sonicEnabled`），而非单个设备的类型判断。

### 3. WebSocket 即设备锁

Sonic Agent 的设备锁通过 WebSocket 连接生命周期管理——建立连接即占用设备，关闭连接即释放设备。不需要额外调用 occupy/release API。

---

## 架构

### 平台路由

```
SONIC_ENABLE=false（默认）        SONIC_ENABLE=true
──────────────────────            ──────────────────────────────
Android → AndroidAdapter          Android → SonicAndroidAdapter
iOS     → IosAdapter              iOS     → SonicIosAdapter
Desktop → DesktopAdapter    ←→    Desktop → DesktopAdapter（不变）
Aurora  → AuroraAdapter           Aurora  → AuroraAdapter（不变）
Browser → BrowserAdapter          Browser → BrowserAdapter（不变）
```

### 数据流

```
启动时（SONIC_ENABLE=true）:
  SonicDeviceSource
    ├── GET /server/api/controller/agents?id={agentId}
    │     → 获取 agentHost, agentPort, agentKey（缓存，不再轮询）
    └── GET /server/api/controller/devices/listByAgentId?agentId={agentId}
          → 构建 Device[]（定时轮询刷新）

device_list 调用:
  DeviceManager.listDevices()
    ├── sonicEnabled=false → 本地 AndroidAdapter/IosAdapter（不变）
    └── sonicEnabled=true  → SonicDeviceSource.listDevices()

device_set(udId) 调用:
  DeviceManager
    ├── sonicEnabled=true, platform=android → new SonicAndroidAdapter(udId, conn)
    │                                              → connect() 建立主控 WebSocket
    ├── sonicEnabled=true, platform=ios     → new SonicIosAdapter(udId, conn)
    └── sonicEnabled=false                  → 现有本地逻辑（不变）

工具调用（input_tap / ui_tree / screen_capture / shell ...）:
  → activeAdapter.xxx()  ← 上层完全透明

device 切换 / session 结束:
  → adapter.dispose() → 关闭 WebSocket → 设备自动释放
```

---

## 新增文件

```
src/sonic/
  ├── sonic-device-source.ts    # Sonic Server API 轮询，维护 Device 列表
  ├── sonic-ws-client.ts        # WebSocket 连接封装（控制帧 + 二进制帧 + terminal）
  ├── sonic-android-adapter.ts  # PlatformAdapter 实现（Android WebSocket 协议）
  └── sonic-ios-adapter.ts      # PlatformAdapter 实现（iOS WebSocket 协议）

cli/src/sonic.rs                # CLI 侧设备发现（一次性拉取）+ WebSocket 执行
```

## 修改文件（最小化）

```
src/device-manager.ts    # listDevices 接入 SonicDeviceSource；selectDevice 加 sonic 路由分支
src/index.ts             # SONIC_ENABLE 时初始化 SonicDeviceSource，注册进程退出清理
cli/src/main.rs          # devices 命令合并 Sonic 设备；各命令支持 Sonic 后端路由
```

---

## 详细设计

### 环境变量

| 变量 | 必须 | 说明 |
|---|---|---|
| `SONIC_ENABLE` | 是 | `true` 启用 Sonic 模式 |
| `SONIC_BASE_URL` | 是 | Sonic Server 地址，如 `http://sonic-server:9090` |
| `SONIC_AGENT_ID` | 是 | 目标 Agent ID（整数） |
| `SONIC_TOKEN` | 是 | 认证 Token |
| `SONIC_POLL_INTERVAL` | 否 | 设备列表刷新间隔 ms，默认 `30000` |

### SonicConnectionInfo 类型定义

```typescript
export interface SonicConnectionInfo {
  agentHost: string;   // 来自 /agents API 的 host 字段
  agentPort: number;   // 来自 /agents API 的 port 字段
  key: string;         // 来自 /agents API 的 agentKey 字段（注意原始字段名为 agentKey）
  token: string;       // 来自环境变量 SONIC_TOKEN
}
```

### SonicDeviceSource

**HTTP 客户端：** 使用 Node.js 18+ 内置的 `fetch`，无需额外依赖。

```typescript
class SonicDeviceSource {
  constructor(
    baseUrl: string,          // SONIC_BASE_URL
    agentId: number,          // SONIC_AGENT_ID（整数）
    token: string,            // SONIC_TOKEN
    pollInterval?: number,    // SONIC_POLL_INTERVAL ms，默认 30000
  )

  // 启动：拉 agentInfo（一次）+ 首次拉设备列表 + 启动轮询 timer
  // agentInfo 失败则抛出异常，进程启动失败（早发现配置错误，优于第一次工具调用时才报错）
  async start(): Promise<void>

  // 单次拉取（CLI 使用，不启动 timer）
  async fetchOnce(): Promise<void>

  // 停止轮询（MCP server SIGTERM/SIGINT 时调用）
  stop(): void

  // DeviceManager 调用
  listDevices(): Device[]
  getConnectionInfo(): SonicConnectionInfo
}
```

**轮询策略：**
- agent info（host/port/key）只在 `start()` 时拉一次，不轮询（不会变）
- 设备列表按 `SONIC_POLL_INTERVAL` 定时刷新
- 轮询失败静默降级，保留上次缓存，不影响已选中设备的工作
- 设备列表原子替换，离线设备下次轮询后自然消失

**Sonic Server API：**
- `GET /server/api/controller/agents?id={agentId}` — 返回 `{ host, port, agentKey }`
- `GET /server/api/controller/devices/listByAgentId?agentId={agentId}` — 返回设备列表
  - `udId` → `device.id`
  - `nickName` → `device.name`
  - `platform`（1=Android, 2=iOS）→ `device.platform`
  - `status`（"ONLINE"/"OFFLINE"）→ `device.state`
  - `isSimulator` 固定为 `false`（Sonic 管理的都是真机）

### SonicWsClient

```typescript
class SonicWsClient {
  // 建立 WebSocket 连接
  async connect(url: string): Promise<void>

  // 发送命令，等待特定 msg 响应（如 ui_tree 等待 "tree"）
  async sendAndWait(payload: object, expectedMsg: string, timeout?: number): Promise<object>

  // 发送命令，等待二进制帧（screenshot）
  async sendForBinary(payload: object, timeout?: number): Promise<Buffer>

  // 发送命令，不等响应（tap/swipe 等）
  send(payload: object): void

  // 关闭连接
  disconnect(): void
}
```

消息路由：收到文本帧时按 `msg` 字段分发给对应的等待者；收到二进制帧时交给 screenshot 等待者。

### SonicAndroidAdapter

实现 `PlatformAdapter` 接口，内部维护两条 WebSocket 连接：

| 连接 | 路径 | 用途 |
|---|---|---|
| 主控 WS | `/websockets/android/{key}/{udId}/{token}` | tap/swipe/screenshot/ui_tree/app 管理等 |
| Terminal WS | `/websockets/android/terminal/{key}/{udId}/{token}` | shell 命令、logcat |

**主控 WS 操作映射：**

| PlatformAdapter 方法 | 发送 | 等待 |
|---|---|---|
| `tap(x, y)` | `{ type:"debug", detail:"tap", point:"x,y" }` | 无（fire-and-forget） |
| `doubleTap(x, y)` | 连续两次 tap，间隔 100ms | 无 |
| `longPress(x, y)` | `{ type:"debug", detail:"longPress", point:"x,y" }` | 无 |
| `swipe(x1,y1,x2,y2)` | `{ type:"debug", detail:"swipe", pointA:"x1,y1", pointB:"x2,y2" }` | 无 |
| `inputText(text)` | `{ type:"text", detail:text }` | 无 |
| `pressKey(key)` | `{ type:"keyEvent", detail:keycode }` | 无 |
| `screenshotAsync()` | `{ type:"debug", detail:"screenshot" }` | 二进制帧 |
| `getScreenshotBufferAsync()` | 同 `screenshotAsync()`，直接返回原始 `Buffer`（不压缩） | 二进制帧 |
| `getUiHierarchy()` | `{ type:"debug", detail:"tree" }` | `{ msg:"tree" }` |
| `launchApp(pkg)` | `{ type:"debug", detail:"openApp", pkg }` | 无 |
| `stopApp(pkg)` | `{ type:"debug", detail:"killApp", pkg }` | 无 |
| `installApp(path)` | `{ type:"debug", detail:"install", apk:path }` | `{ msg:"installFinish" }` |
| `swipeDirection(dir)` | 计算坐标后委托 `swipe()`（屏幕宽高从 `wm size` shell 命令获取） | 无 |
| `getSystemInfo()` | 第一期抛出 `"not supported on sonic-android"`（后续迭代通过 shell 实现） | — |
| `grantPermission / revokePermission / resetPermissions` | 通过 `shell()` 执行 `pm grant/revoke` | Terminal WS |

**Terminal WS 操作（按需连接，用完关闭）：**

| PlatformAdapter 方法 | 发送 | 等待 |
|---|---|---|
| `shell(cmd)` | `{ type:"command", detail:cmd }` | 流式 `terResp` 直到 `terDone` |
| `getLogs()` | `{ type:"logcat", level:"V", filter:"" }` | 流式 `logcatResp` |
| `clearLogs()` | ADB `logcat -c`（通过 shell） | — |

### SonicIosAdapter

同 Android，路径改为 `/websockets/ios/...` 和 `/websockets/ios/terminal/...`，操作映射对应 iOS 协议：

| PlatformAdapter 方法 | 发送 | 等待 |
|---|---|---|
| `tap(x, y)` | `{ type:"debug", detail:"tap", point:"x,y" }` | 无 |
| `longPress(x, y)` | `{ type:"debug", detail:"longPress", point:"x,y" }` | 无 |
| `swipe(x1,y1,x2,y2)` | `{ type:"debug", detail:"swipe", pointA, pointB }` | 无 |
| `inputText(text)` | `{ type:"send", detail:text }` | 无 |
| `pressKey(key)` | `{ type:"debug", detail:"keyEvent", key }` | 无 |
| `screenshotAsync()` | `{ type:"debug", detail:"screenshot" }` | 二进制帧 |
| `getScreenshotBufferAsync()` | 同 `screenshotAsync()`，直接返回原始 `Buffer`（不压缩） | 二进制帧 |
| `getUiHierarchy()` | `{ type:"debug", detail:"tree" }` | `{ msg:"tree" }` |
| `launchApp(pkg)` | `{ type:"launch", pkg }` | `{ msg:"launchResult" }` |
| `stopApp(pkg)` | `{ type:"kill", pkg }` | `{ msg:"killResult" }` |
| `installApp(ipa)` | `{ type:"debug", detail:"install", ipa:path }` | `{ msg:"installFinish" }` |
| `swipeDirection(dir)` | 计算坐标后委托 `swipe()`（同 Android） | 无 |
| `getLogs()` | Terminal WS: `{ type:"syslog", filter:"" }` | 流式 syslog |
| `getSystemInfo()` | 不支持，抛出 `"not supported on sonic-ios"` | — |
| `grantPermission / revokePermission / resetPermissions` | 不支持，抛出 `"not supported on sonic-ios"` | — |

### DeviceManager 变更

```typescript
// selectDevice 新增 sonic 路由分支
async selectDevice(id: string): Promise<void> {
  const device = await this.findDevice(id);

  if (this.sonicEnabled && (device.platform === 'android' || device.platform === 'ios')) {
    const conn = this.sonicSource!.getConnectionInfo();
    const adapter = device.platform === 'android'
      ? new SonicAndroidAdapter(device.id, conn)
      : new SonicIosAdapter(device.id, conn);
    await this.activeAdapter?.dispose();   // 关旧连接
    await adapter.connect();               // 建新连接（隐式锁定设备）
    this.activeAdapter = adapter;
    return;
  }

  // 现有本地逻辑不动
}

// listDevices 新增 sonic 数据源
async listDevices(): Promise<Device[]> {
  if (this.sonicEnabled) {
    const sonicDevices = this.sonicSource!.listDevices();
    const otherDevices = await this.listNonMobileDevices(); // Desktop/Aurora/Browser
    return [...sonicDevices, ...otherDevices];
  }
  // 现有逻辑不动
}
```

### MCP Server 生命周期（src/index.ts）

```typescript
// server.connect() 之前启动
if (process.env.SONIC_ENABLE === 'true') {
  const sonicSource = new SonicDeviceSource(
    process.env.SONIC_BASE_URL!,
    Number(process.env.SONIC_AGENT_ID),
    process.env.SONIC_TOKEN!,
    process.env.SONIC_POLL_INTERVAL ? Number(process.env.SONIC_POLL_INTERVAL) : undefined,
  );
  await sonicSource.start();              // 失败则进程启动失败（早发现）
  deviceManager.setSonicSource(sonicSource);
}
await server.connect(transport);

// 进程退出时清理 timer
process.on('SIGTERM', () => sonicSource?.stop());
process.on('SIGINT',  () => sonicSource?.stop());
```

### CLI 生命周期（cli/src/sonic.rs）

CLI 为短生命周期进程，不需要轮询：

```
1. 读取环境变量，SONIC_ENABLE 未设则跳过
2. GET /agents      → 拿 host/port/key（一次性）
3. GET /devices     → 拿设备列表（一次性，无 timer）
4. 找到目标设备，建 WebSocket 执行命令
5. 进程退出，WebSocket 自动关闭，设备自动释放
```

---

## PlatformAdapter 接口变更

Sonic adapter 的操作天然是异步的（WebSocket 往返），但 `PlatformAdapter` 接口中以下方法目前是同步签名，需要作为本次集成的一部分升级为 `async`：

| 方法 | 当前签名 | 升级后 |
|---|---|---|
| `launchApp` | `string` | `Promise<string>` |
| `stopApp` | `void` | `Promise<void>` |
| `installApp` | `string` | `Promise<string>` |
| `shell` | `string` | `Promise<string>` |
| `getLogs` | `string` | `Promise<string>` |
| `clearLogs` | `string` | `Promise<string>` |
| `grantPermission` | `string` | `Promise<string>` |
| `revokePermission` | `string` | `Promise<string>` |
| `resetPermissions` | `string` | `Promise<string>` |

**影响范围（三层都需同步修改）：**
1. `PlatformAdapter` 接口：升级上表中各方法的返回类型
2. 现有 Adapter 实现：AndroidAdapter、IosAdapter、DesktopAdapter、AuroraAdapter 对应方法改为 `async`（大多内部已用 `execSync`，改为 `execAsync` 即可）
3. `DeviceManager` wrapper 方法：`DeviceManager.shell()`、`DeviceManager.launchApp()`、`DeviceManager.getLogs()` 等直接封装 adapter 调用的方法，也必须改为 `async` 并加 `await`，否则 adapter 升级后 DeviceManager 层会静默返回 `Promise` 对象而非实际结果
4. 工具层（`tools/`）：调用上述 DeviceManager 方法的工具代码需加 `await`

**`screenshotRaw()`：** 这是历史遗留的同步路径。Sonic adapter 将抛出 `"not supported — use screenshotAsync()"`，不升级为 async。现有工具已优先使用 `screenshotAsync()`，影响可控。

**`listDevices() / selectDevice() / autoDetectDevice()`：** Sonic 模式下设备管理由 `SonicDeviceSource` + `DeviceManager` 负责，Sonic adapter 的这几个方法实现为空 stub（`listDevices` 返回 `[]`，其余 no-op）。

**`dispose()` 生命周期方法：** 在 `PlatformAdapter` 接口新增可选方法 `dispose?(): Promise<void>`。本地 adapter 默认不实现（undefined = no-op）。Sonic adapter 实现此方法，内部调用 `SonicWsClient.disconnect()` 关闭 WebSocket。`DeviceManager.selectDevice()` 在切换 adapter 前调用 `await this.activeAdapter?.dispose?.()` 触发清理。

---

## 工具层绕过 Adapter 的已知限制

部分工具通过 `DeviceManager.getAndroidClient()` / `getIosClient()` 直接访问底层客户端，绕过了 adapter 路由。在 `SONIC_ENABLE=true` 时这些工具将无法正常工作：

| 工具 | 原因 |
|---|---|
| `clipboard_get_android`、`clipboard_select`、`clipboard_copy`、`clipboard_paste` | 调用 `getAndroidClient()` |
| `system_activity` | 调用 `getAndroidClient().getCurrentActivity()` |
| `system_open_url`（Android） | 调用 `getAndroidClient().shell(...)` |
| `system_open_url`（iOS） | 调用 `getIosClient().openUrl()` |
| `ui_find`（iOS element-level） | 调用 `getIosClient().findElements()` |
| `system_webview` | 调用 `getWebViewInspector()` |

**第一期处理策略：** 以上工具在 Sonic 模式下调用时返回明确的错误信息（`"not supported in Sonic mode"`），不静默失败。后续迭代中根据需要将对应能力移入 `PlatformAdapter` 接口。

---

## 已知限制

- **`doubleTap`（Android）：** 通过两次连续 `send()`（间隔 100ms）实现，fire-and-forget，无送达确认。在网络延迟较高时两次 tap 间隔可能不准确。第一期接受此限制。
- **Terminal WS 连接失败：** `shell()` / `getLogs()` 按需连接 terminal WebSocket，若连接失败则直接抛出错误，不重试。
- **`SONIC_ENABLE` 互斥语义：** Android/iOS 设备来源在本地和 Sonic 之间二选一，不支持混合使用。若同时需要本地模拟器和远程真机，需启动两个独立的 MCP server 实例。此约束是有意为之——实际场景中两者很少需要同时使用，混合模式会显著增加实现复杂度。

---

## 第一期范围

- SonicDeviceSource：设备发现 + 定时轮询
- SonicAndroidAdapter：tap/swipe/longPress/inputText/pressKey/screenshot/ui_tree/app管理/shell/logs
- SonicIosAdapter：tap/swipe/longPress/inputText/pressKey/screenshot/ui_tree/app管理/syslog
- DeviceManager：sonic 模式路由
- CLI（Rust）：设备发现 + 主要命令支持
- MCP server 生命周期管理

## 超出第一期范围

- 性能监控（perfmon）
- 网络代理（sonic-go-mitmproxy）
- 音频流
- WebView 调试代理
- 多 Agent 支持（当前只支持单 SONIC_AGENT_ID）
