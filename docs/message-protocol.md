# 消息协议

本文档说明 Yuanbao Lite 与腾讯元宝 WebSocket 网关之间的通信协议。

## 连接流程

```
客户端                              Tencent WSS 网关
  │                                       │
  │  1. HTTPS POST /sign-token            │
  │ ─────────────────────────────────→    │
  │  ←────── { bot_id, token, duration }  │
  │                                       │
  │  2. WSS 连接 wss://bot-wss.../wss/connection
  │ ─────────────────────────────────→    │
  │                                       │
  │  3. 发送 ConnMsg (type=auth_bind)     │
  │     { bizId, uid, source, token }     │
  │ ─────────────────────────────────→    │
  │  ←────── ConnMsg (auth_bind_rsp)      │
  │          { connectId }                │
  │                                       │
  │  4. 定期发送 Ping (30s)               │
  │ ─────────────────────────────────→    │
  │  ←────── Pong                         │
  │                                       │
  │  5. 接收 Push 消息 (dispatch)         │
  │  ←─────────────────────────────────   │
  │  ─────── PushAck ─────────────────→   │
  │                                       │
```

## Sign-Token 签名

### 请求

```
POST https://bot.yuanbao.tencent.com/api/v5/robotLogic/sign-token
Content-Type: application/json
X-AppVersion: 1.0.0
X-OperationSystem: Linux  (或 Browser)

{
  "app_key": "你的AppKey",
  "nonce": "32字符随机十六进制",
  "signature": "HMAC-SHA256(appSecret, nonce+timestamp+appKey+appSecret)",
  "timestamp": "2026-06-22T12:00:00+08:00"
}
```

### 签名算法

```typescript
const plain = nonce + timestamp + appKey + appSecret;
const signature = await hmacSha256Hex(appSecret, plain);
```

**实现**：使用 Web Crypto API（`crypto.subtle.importKey` + `sign`），Node 18+ 和浏览器均可用。

### 响应

```json
{
  "code": 0,
  "data": {
    "bot_id": "bot_xxx",
    "duration": 2073600,
    "product": "yuanbao",
    "source": "bot",
    "token": "签名的WS认证token"
  }
}
```

Token 有效期 24 小时，引擎自动在到期前 5 分钟刷新。

## WebSocket 帧格式

所有 WSS 消息使用 **Protobuf** 编码，外层为 `ConnMsg`：

```protobuf
message ConnMsg {
  ConnHead head = 1;
  ConnBody body = 2;
}

message ConnHead {
  uint32 type = 1;      // 消息类型（见下表）
  uint32 seq = 2;       // 序列号
  string route = 3;     // 路由
  // ...
}

message ConnBody {
  bytes data = 1;       // 业务消息（内层 protobuf）
}
```

### 消息类型

| 类型 | 名称            | 方向 | 说明       |
| ---- | --------------- | ---- | ---------- |
| 1    | `auth_bind`     | →    | 认证绑定   |
| 2    | `auth_bind_rsp` | ←    | 认证响应   |
| 3    | `ping`          | →    | 心跳       |
| 4    | `pong`          | ←    | 心跳响应   |
| 5    | `dispatch`      | ←    | 服务器推送 |
| 6    | `push_ack`      | →    | 推送确认   |
| 7    | `biz_request`   | →    | 业务请求   |
| 8    | `biz_response`  | ←    | 业务响应   |

## 业务消息

`ConnBody.data` 字段是内层 Protobuf 编码的业务消息。根据 `ConnHead.route` 区分类型：

### send_c2c_message（发送私聊）

```protobuf
message SendC2CMessageReq {
  string to_account = 1;
  string from_account = 2;
  repeated MsgBodyElement msg_body = 3;
  string msg_id = 4;       // 可选：引用消息
  string cloud_custom_data = 5;  // @提及数据
}

message MsgBodyElement {
  string msg_type = 1;     // TIMTextElem, TIMCustomElem, TIMImageElem, ...
  google.protobuf.Struct msg_content = 2;
}
```

### send_group_message（发送群聊）

```protobuf
message SendGroupMessageReq {
  string group_code = 1;
  string from_account = 2;
  repeated MsgBodyElement msg_body = 3;
  string msg_id = 4;
  uint32 msg_seq = 5;
  string cloud_custom_data = 6;
}
```

### inbound_message（接收消息推送）

```protobuf
message InboundMessage {
  string callback_command = 1;  // C2C.CallbackAfterSendMsg / Group.CallbackAfterSendMsg
  string from_account = 2;
  string to_account = 3;
  string group_code = 4;
  repeated MsgBodyElement msg_body = 5;
  string msg_id = 6;
  uint32 msg_seq = 7;
  string cloud_custom_data = 8;
  uint32 chat_type = 9;
  // ...
}
```

## 消息体元素类型

| msg_type           | 说明                | msg_content 示例                                 |
| ------------------ | ------------------- | ------------------------------------------------ |
| `TIMTextElem`      | 纯文本              | `{ text: "你好" }`                               |
| `TIMCustomElem`    | 自定义元素（@提及） | `{ data: "base64编码的JSON" }`                   |
| `TIMImageElem`     | 图片                | `{ image_info_array: [{ url, width, height }] }` |
| `TIMFileElem`      | 文件                | `{ url, file_size, file_name }`                  |
| `TIMFaceElem`      | 表情/贴纸           | `{ index: 0, data: "JSON(sticker_id)" }`         |
| `TIMVideoFileElem` | 视频                | `{ video_url, video_size, ... }`                 |
| `TIMSoundElem`     | 语音                | `{ url, size, duration }`                        |

## @提及协议

@提及通过 `cloud_custom_data` 字段传递：

```json
{
  "mention": {
    "user_list": [
      { "user_id": "user123", "nickname": "小明" },
      { "user_id": "bot_xxx", "nickname": "" }
    ],
    "at_all": false
  }
}
```

`@[昵称](id)` 语法在消息文本中被解析为 `TIMCustomElem` 元素，与文本元素交错排列。

## Protobuf 加载方式

所有 `.proto` 文件在编译时通过 `protobufjs` 的静态代码生成或运行时 `Root.fromJSON()` 加载。

Yuanbao Lite 使用 **运行时 JSON 描述符** 方式：

```typescript
// src/access/ws/proto/biz.json
// 预编译的 protobufjs JSON 描述符
import bizProto from "./biz.json" with { type: "json" };
import connProto from "./conn.json" with { type: "json" };

const root = protobuf.Root.fromJSON(bizProto);
const ConnMsg = root.lookupType("ConnMsg");
```

**优势**：

- 无需 `.proto` 文件运行时解析
- 浏览器兼容（`protobufjs` 有浏览器 bundle）
- Tree-shaking 友好

## 媒体上传协议

### COS 上传流程

1. 调用 `/api/resource/genUploadInfo` 获取 COS 预签名配置
2. PUT 文件到 COS 预签名 URL
3. 使用返回的 `resourceUrl` 在消息体中引用

### COS v1 签名

```
Authorization: q-sign-algorithm=sha1
              &q-ak=<SecretId>
              &q-sign-time=<startTime>;<endTime>
              &q-key-time=<startTime>;<endTime>
              &q-header-list=host
              &q-url-param-list=
              &q-signature=<HMAC-SHA1(SignKey, StringToSign)>
```

**SignKey** = `HMAC-SHA1(SecretKey, KeyTime)`
**StringToSign** = `sha1\n<SignTime>\n<HMAC-SHA1(StringToSign)>\n`

**实现**：使用 Web Crypto API 的 `importKey` + `sign`（HMAC-SHA1）。

### MD5 文件指纹

COS 上传协议要求文件 MD5 作为 `uuid`（去重标识）。Web Crypto API 不支持 MD5，使用 `js-md5` 库实现。

## 错误码

| code  | 含义         | 处理              |
| ----- | ------------ | ----------------- |
| 0     | 成功         | —                 |
| 10099 | 签名临时失败 | 重试（最多 3 次） |
| 401   | 认证失败     | 刷新 sign-token   |
| 429   | 限流         | 等待后重试        |

## 心跳机制

- 客户端每 30 秒发送 `ping`
- 服务器响应 `pong`
- 10 秒内未收到 `pong` 视为连接断开，触发重连

## 重连策略

- 最大重连次数：100（可配置）
- 重连延迟：1s, 2s, 5s, 10s, 30s（指数退避）
- 重连时自动刷新 sign-token

## 相关源码

| 文件                          | 说明                   |
| ----------------------------- | ---------------------- |
| `src/access/ws/client.ts`     | WebSocket 客户端       |
| `src/access/ws/conn-codec.ts` | ConnMsg 编解码         |
| `src/access/ws/biz-codec.ts`  | 业务消息编解码         |
| `src/access/ws/proto/*.proto` | Protobuf 定义          |
| `src/access/ws/proto/*.json`  | 预编译的 JSON 描述符   |
| `src/access/http/request.ts`  | Sign-token + HTTP 工具 |
| `src/access/http/media.ts`    | 媒体上传/下载          |
