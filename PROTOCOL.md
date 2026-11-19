# 浏览器 ↔ DSH host 语音通道协议（v1）

浏览器 client 插件与 host 插件之间**只有一条同源 WebSocket**：

```
ws(s)://<location.host>/moss-live/v1
```

- 同源 cookie 自动携带，host 用 `ctx.connection.requestRejection(req)` 校验；未登录直接 401。
- 二进制帧 = PCM 音频；文本帧 = UTF-8 JSON。
- host 是唯一持有 `MOSS_API_KEY` 的地方，浏览器永远不碰密钥、也不直连 MOSS。

## 1. host → 浏览器

### 1.1 `status`

```jsonc
{ "type": "status",
  "data": { "state": "idle|connecting|live|error", "message": "可选说明",
            "upstream": true, "model": "moss-live-1.0" } }
```

连接建立后 host 会主动推一条。`state` 语义：

| state | 含义 |
|---|---|
| `idle` | 未开始 / 已停止 |
| `connecting` | 上游已连上，等 `session_attached` |
| `live` | MOSS 会话已建立，可以开麦 |
| `error` | 出错，`message` 是原因（可直接展示） |

### 1.2 `moss`

```jsonc
{ "type": "moss", "data": { "action": "session_attached", "data": { ... } } }
```

`data` 就是 MOSS 原始事件（`{action, data}`），host 只做白名单过滤，**不改写**。
浏览器按 MOSS 协议自行处理（见 §3）。被过滤掉不转发的是委派内部事件：
`session.delegation.created|cancelled`、`session.thinking.appended`、
`session.commentary.appended`、`session.instructions.appended`。

### 1.3 `task`

```jsonc
{ "type": "task",
  "data": { "delegationId": "…", "status": "queued|running|completed|failed",
            "title": "用户这句话的前 60 字", "purpose": "task|reasoning" } }
```

DSH 后台任务的进度，用于 UI 显示"后台在干活"。

### 1.4 `key`

```jsonc
{ "type": "key",
  "data": { "configured": true, "masked": "••••abcd",
            "source": "key-file|config-file|env|none",
            "path": "/Users/you/.dsh/moss-live.key",
            "error": "可选：保存失败原因" } }
```

密钥状态。**永远不含明文**，浏览器只拿到掩码；连接建立后客户端会主动问一次。

### 1.5 `pong`

```jsonc
{ "type": "pong", "data": { "time": 1700000000000 } }
```

## 2. 浏览器 → host

| 文本消息 | 作用 |
|---|---|
| `{ "action": "start" }` | 让 host 建上游 MOSS 连接（幂等） |
| `{ "action": "stop" }` | 关闭上游、取消任务 |
| `{ "action": "ping" }` | 连通性探测 |
| `{ "action": "keyStatus" }` | 读取密钥状态（返回 `type:'key'`） |
| `{ "action": "setKey", "key": "sk-…" }` | 写入密钥文件（0600），返回新状态 |
| `{ "action": "clearKey" }` | 删除插件写入的密钥文件，返回新状态 |
| `{ "action": "moss", "data": { … } }` | 把一条 MOSS 事件原样发给 upstream（`session.update`、`mic_state`、`media.mode`、`playback.*`、`conversation.item.create`、`response.create` …） |

### HTTP 边车（不占用语音连接）

| 方法与路径 | 作用 |
|---|---|
| `GET /moss-live/key` | 读取密钥状态（掩码） |
| `POST /moss-live/key` | `{action:'set', key}` / `{action:'clear'}`，写入 `0600` 文件 |
| `GET /moss-live/history?limit=60` | 读最近 N 条转写历史 `{entries:[{at,role,text,sessionId}]}` |
| `DELETE /moss-live/history` | 清空历史 |

三者都走 DSH cookie 鉴权（`requestRejection`），未登录 401。

**二进制帧**：上行 16 kHz 单声道 PCM S16LE，每帧 20 ms（320 samples / 640 bytes），**前置 1 字节 tag `0x00`**（`media.mode` 声明 `tagged-v1` 后）。

> **会话配置由 host 负责**：收到 `session_attached` 后 host 会自己发 `media.mode` 和
> `session.update`（instructions 人设）。浏览器**不要**再发这两条，只要等 `session.updated`
> 且 `data.error` 为空后再开麦。

host 收到二进制时：上游已连接 → 原样转发；否则若 `config.loopbackAudio` 为 true → 原样回灌给浏览器（本地音频自测用）。

## 3. 浏览器必须处理的 MOSS 事件

| 事件 | 浏览器动作 |
|---|---|
| `session_attached` | 记下 `data.session_id`；发 `media.mode` + `session.update`；等 `session.updated` |
| `session.updated` | `data.error` 为空才开麦；出错则停止输入并显示错误 |
| `response.audio.started{run_id,turn_id}` | 开一个播放 scope |
| `response.audio.context{chunk_id,run_id,turn_id}` | 压入待匹配队列（**一帧音频对应一个 context**） |
| `response.audio.done{run_id,turn_id}` | 标记该 run 音频发完（先别发 `playback.completed`） |
| `response.audio.stop{run_id,turn_id,reason}` | 立即停播+清空该 run，回 `playback.stopped`（带 `played_audio_ms`） |
| `response.interrupted` | 该回复终态，标记结束，继续等下一轮 |
| `response.ended{status}` | 一轮结束，更新 UI |
| `input.transcript.updated/.done/.revised` | `data.text` 是**完整文本**，覆盖展示 |
| `output.transcript.updated/.done` | 同上，按 `run_id` 归档 |
| `error` | 展示 `data.error.code`（可脱敏） |

播放回执（浏览器 → host → MOSS）：

```jsonc
// 每个 chunk 真正播完
{ "action": "playback.chunk.completed", "chunk_id": "…", "run_id": "…", "turn_id": "…" }
// 整个 run 的音频全部播完
{ "action": "playback.completed", "run_id": "…", "turn_id": "…" }
// 被打断
{ "action": "playback.stopped", "run_id": "…", "turn_id": "…", "played_audio_ms": 1234, "reason": "…" }
```

## 3.1 真机补充（2026-11-18 用真实服务抓到的）

官方字段表里没有、但真实服务确实会发的事件，客户端按"未知事件忽略"处理即可：

| 事件 | 说明 |
|---|---|
| `input.speech.started` / `input.speech.stopped` | VAD 起止，可用来做"正在说话"的视觉反馈 |
| `input.transcript.updated` 里的 `stable_text` | 已定型的部分，`text` 是含未定型的完整文本 |
| `response.audio.started` 里的 `kind` | 实测为 `speech` |

其它实测结论：

- 下行音频块固定 **9600 B = 4800 samples = 100 ms @48k**（最后一块可能更短），
  每块前必有一条 `response.audio.context`，**严格一配一**。
- 委派回执：`session.commentary.append` / `session.thinking.append` 发出后，
  服务端用 `session.commentary.appended` / `session.thinking.appended` 带 `client_event_id` 确认；
  SDK 内部已处理，插件不需要自己管。
- `session.updated.data.error` 正常时是**空字符串** `""`，不是 `undefined`。

## 4. 音频参数（照抄参考实现）

参考实现（已解包，直接读）：`/tmp/mosslive-pkg/package/examples/browser-demo/web/js/`
- `pcm.js`：`MicFramer` / `LowPassFIR` / `LinearResampler` / `floatToPCM16` / `pcm16ToFloat`
- `mic.js`：AudioWorklet 采集（`capture-worklet.js`）
- `playback.js`：`PlaybackLedger`（回执状态机，**直接搬**）
- `speaker.js`：48k 播放调度
- `public-session.js`：事件 → ledger/speaker/字幕 的粘合层

| 方向 | 采样率 | 格式 | 帧 |
|---|---|---|---|
| 上行 | 16 kHz | 单声道 PCM S16LE，**1 字节 tag 前缀** | 20 ms = 640 B + 1 B |
| 下行 | 48 kHz | 单声道 PCM S16LE，**裸数据无 tag** | 按 `response.audio.context` 分块 |

静音也要持续上行（模型靠它判断停顿）。

## 5. 客户端模块形态

`client.js` 由 `window.__ModuleLoader__.load({ id, factory(require) })` 注册，React 来自 `require('react')`，
**单一自包含文件**（不要拆多文件、不要用裸 import、不要 CDN）。
挂载点：`conversation.composer.dock`（host 已用同一 slot）。

```js
window.__ModuleLoader__.load({
  id: 'dsh-moss-live-voice',
  factory(require) {
    const React = require('react')
    // …组件与音频逻辑…
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'moss-live-voice', order: 20,
        }, VoiceDock))
      },
    }
  },
})
```
