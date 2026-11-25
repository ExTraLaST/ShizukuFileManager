# Shizuku 互联协议规范（Protocol v1）

> 本文档是 **Shizuku 文件管理器** Windows 电脑版与 Android 安卓版内置互联功能的唯一协议规范，兼容电脑版 v1.11.0 与安卓版 v1.23，支持手机 ↔ 电脑、电脑 ↔ 电脑、手机 ↔ 手机任意双向访问与聊天传输。

---

## 1. 传输与基础约定

- **协议版本**：`PROTOCOL_VERSION = 1`
- **默认 HTTP 端口**：`8898`（用户可自定义 `1–65535`）
- **固定 UDP 发现端口**：`8897`（与 HTTP 端口解耦，HTTP 改端口后仍可自动发现）
- **数据格式**：控制与元数据接口统一使用 `HTTP/1.1 + JSON (UTF-8)`；文件上传/下载与附件上传使用原始二进制流 `application/octet-stream`。
- **设备持久标识**：每台设备首次开启互联服务时生成 `UUID v4` 并持久化保存，随 `/api/info` 及 UDP 发现响应返回 `id` 字段，供对端在局域网 IP 变更时自动识别同一台设备。

---

## 2. 密码 Token 鉴权

- 服务端密码不可为空（为空时拒绝启动）。
- 所有 `/api/*` 请求必须携带请求头：
  ```http
  X-Shizuku-Token: <password>
  ```
- 服务端将收到的 token 与本机密码分别做 `SHA-256` 摘要后执行**恒定时间比较**（防止时序攻击与长度泄露）。
- 校验失败返回 `401 Unauthorized`：
  ```json
  { "ok": false, "error": "密码错误" }
  ```

---

## 3. 路径规范（Wire Path）

- **Windows 电脑端**：统一使用正斜杠与大写盘符。
  - 根目录：`C:/`、`D:/`
  - 子路径：`C:/Users/demo/report.pdf`
- **Android 手机端**：标准 POSIX 绝对路径。
  - 根目录：`/storage/emulated/0`（或 `/`）
  - 子路径：`/storage/emulated/0/Download/photo.jpg`
- **安全校验**：
  - 禁止包含空字符 `\0`、反斜杠 `\`、路径段 `..`。
  - 映射为本地绝对路径后，必须验证位于对应根白名单内部，越界返回 `400 {"ok":false,"error":"路径不合法"}`。

---

## 4. UDP 自动发现

- **服务端**：监听 `0.0.0.0:8897`（UDP）。仅当收到的报文体精确等于 ASCII 字符串 `SHIZUKU-LINK-DISCOVER` 时，向来源 IP/端口单播回复：
  ```text
  SHIZUKU-LINK-HERE {"name":"设备名称","type":"pc","port":8898,"version":1,"id":"<uuid>"}
  ```
  其中 `type` 为 `"pc"` 或 `"phone"`。
- **客户端**：向 `255.255.255.255` 及各非回环 IPv4 网卡的子网广播地址发送 3 轮请求（间隔 300ms），总收集窗口 2500ms；自动过滤本机 IP、校验 `version === 1` 与合法端口、按 `host:port` 去重。

---

## 5. HTTP REST 接口明细

所有 JSON 错误响应统一结构：`{ "ok": false, "error": "错误说明" }`。

### 5.1 设备信息 — `GET /api/info`
- 响应 `200`：
  ```json
  { "ok": true, "name": "MyPC", "type": "pc", "version": 1, "id": "550e8400-e29b-41d4-a716-446655440000" }
  ```

### 5.2 根目录列表 — `GET /api/roots`
- 响应 `200`：
  ```json
  {
    "ok": true,
    "roots": [
      { "name": "系统 (C:)", "path": "C:/", "free": 51200000000, "total": 256000000000 }
    ]
  }
  ```

### 5.3 列目录 — `GET /api/list?path=<wirePath>`
- 响应 `200`：
  ```json
  {
    "ok": true,
    "items": [
      { "name": "demo.mp4", "path": "C:/Videos/demo.mp4", "isDirectory": false, "size": 10485760, "modified": 1730000000000 }
    ]
  }
  ```

### 5.4 查询属性 — `GET /api/stat?path=<wirePath>`
- 响应 `200`（不存在时 `exists: false`，不返回 404）：
  ```json
  { "ok": true, "exists": true, "isDirectory": false, "size": 12345, "modified": 1730000000000 }
  ```

### 5.5 下载与 Range 分段流播 — `GET /api/download?path=<wirePath>`
- 支持标准 HTTP `Range` 头：`bytes=start-end`、`bytes=start-`、`bytes=-suffix`。
- 无 `Range`：返回 `200`，头含 `Accept-Ranges: bytes`、`Content-Length`、`Content-Disposition`。
- 合法 `Range`：返回 `206 Partial Content`，头含 `Content-Range: bytes start-end/total`、`Content-Length: end-start+1`、`Accept-Ranges: bytes`。
- 非法/越界 `Range`：返回 `416 Range Not Satisfiable`，头含 `Content-Range: bytes */total`。

### 5.6 流式上传 — `POST /api/upload?path=<wirePath>`
- 请求体为原始文件字节流，服务端自动创建父目录、写入临时 `.shizuku-part-*` 文件，写完后原子替换目标文件，中断时自动清理临时文件。
- 响应 `200`：`{ "ok": true, "size": 12345 }`。

### 5.7 新建目录 — `POST /api/mkdir`
- 请求 JSON：`{ "path": "<wirePath>" }`
- 响应 `200`：`{ "ok": true }`

### 5.8 删除 — `POST /api/delete`
- 请求 JSON：`{ "path": "<wirePath>" }`（禁止删除根目录）
- 响应 `200`：`{ "ok": true }`

### 5.9 重命名 — `POST /api/rename`
- 请求 JSON：`{ "path": "<wirePath>", "newName": "新文件名.txt" }`
- 冲突返回 `409`；成功返回 `200`：`{ "ok": true, "path": "<newWirePath>" }`

### 5.10 移动 — `POST /api/move`
- 请求 JSON：`{ "path": "<srcWirePath>", "destDir": "<destDirWirePath>" }`
- 禁止移入自身或子目录（`400`）；同目录移动自身直接返回 `200`；目标同名自动改名 `name (2).ext`；跨盘符自动降级复制后删除。
- 响应 `200`：`{ "ok": true, "path": "<finalWirePath>" }`

### 5.11 复制 — `POST /api/copy`
- 请求 JSON：`{ "path": "<srcWirePath>", "destDir": "<destDirWirePath>" }`
- 目标同名自动改名 `name (2).ext`。
- 响应 `200`：`{ "ok": true, "path": "<finalWirePath>" }`

### 5.12 快速访问 — `GET /api/quickaccess`
- 返回设备固定的快速访问文件夹（不含单个文件项）：
  ```json
  { "ok": true, "items": [{ "name": "桌面", "path": "C:/Users/demo/Desktop" }] }
  ```

### 5.13 消息附件上传 — `POST /api/message-file?filename=<name>`
- 请求体为原始二进制流，单文件上限 `2 GB`（超出返回 `413`）。
- 落盘至 `_staging/<fileId>`，响应 `200`：`{ "ok": true, "fileId": "<uuid>" }`。

### 5.14 发送消息 — `POST /api/message`
- 请求 JSON：
  ```json
  {
    "text": "你好",
    "from": "Pixel 9",
    "fromId": "<senderUuid>",
    "time": 1730000000000,
    "attachment": { "fileId": "<uuid>", "name": "photo.jpg", "size": 204800, "mime": "image/jpeg" }
  }
  ```
- `text` 与 `attachment` 至少存在一项；`text` 最大 2000 字符；存在 `attachment` 时校验 `fileId` 安全字符集且已在 `_staging` 存在，随后移动至 `messages/<fromId>/<fileId>` 并持久化，同时触发对端系统通知与界面刷新。
- 响应 `200`：`{ "ok": true }`

### 5.15 远程缩略图 — `GET /api/thumbnail?path=<wirePath>&size=256`
- `size` 夹紧在 `128–512`（默认 `256`）。
- 仅支持图片与视频扩展名；返回 `200` + `image/png` 或 `image/jpeg` + `Cache-Control: private, max-age=86400`；不支持或生成失败返回 `404`。
