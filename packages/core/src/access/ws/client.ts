/**
 * WebSocket client — connection management, auth, heartbeat, and auto-reconnect.
 *
 * Standalone version without OpenClaw dependencies.
 */

import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import {
  encodeSendC2CMessageReq,
  encodeSendGroupMessageReq,
  decodeSendMessageRsp,
  encodeSendPrivateHeartbeatReq,
  encodeSendGroupHeartbeatReq,
  decodeSendPrivateHeartbeatRsp,
  decodeSendGroupHeartbeatRsp,
  encodeQueryGroupInfoReq,
  decodeQueryGroupInfoRsp,
  encodeGetGroupMemberListReq,
  decodeGetGroupMemberListRsp,
  encodeSyncInformationReq,
  decodeSyncInformationRsp,
  encodeQueryBotInfoReq,
  decodeQueryBotInfoRsp,
} from "./biz-codec.js";
import {
  decodeConnMsg,
  decodePB,
  buildAuthBindMsg,
  buildPingMsg,
  buildPushAck,
  buildBusinessConnMsg,
  PB_MSG_TYPES,
  CMD_TYPE,
  CMD,
} from "./conn-codec.js";
import type { PBConnMsg } from "./conn-codec.js";
import type {
  WsClientCallbacks,
  WsClientConfig,
  WsClientState,
  WsConnectionConfig,
  WsSendMessageResponse,
  WsSendC2CMessageData,
  WsSendGroupMessageData,
  WsSendPrivateHeartbeatData,
  WsSendGroupHeartbeatData,
  WsHeartbeatResponse,
  WsQueryGroupInfoData,
  WsQueryGroupInfoResponse,
  WsGetGroupMemberListData,
  WsGetGroupMemberListResponse,
  WsPushEvent,
  WsSyncInformationData,
  WsSyncInformationResponse,
  WsQueryBotInfoResponse,
} from "./types.js";

// ─── Business command constants ───

export const BIZ_CMD = {
  SendC2CMessage: "send_c2c_message",
  SendGroupMessage: "send_group_message",
  SendPrivateHeartbeat: "send_private_heartbeat",
  SendGroupHeartbeat: "send_group_heartbeat",
  QueryGroupInfo: "query_group_info",
  GetGroupMemberList: "get_group_member_list",
  SyncInformation: "sync_information",
  QueryBotInfo: "query_bot_info",
} as const;

const BIZ_MODULE = "yuanbao_openclaw_proxy";

const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 30_000;
const BUSINESS_TIMEOUT_MS = 30_000;

const MAX_MESSAGE_SIZE = 64 * 1024 * 1024; // 64MB

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ─── WebSocket constructor (browser-native or ws-package) ───
//
// We need a WebSocket constructor that works in both Node and browser.
// Strategy:
//   1. If `globalThis.WebSocket` exists (Node 21+ has it as a global;
//      all modern browsers have it), use it directly.
//   2. Otherwise (Node 18-20), dynamically import the `ws` package via
//      top-level await. This keeps `ws` out of the static import graph
//      so browser bundles don't try to include it.
//
// The `ws` package's WebSocket accepts an options object as the 2nd
// constructor arg (e.g. { maxPayload }). The browser's native WebSocket
// accepts only protocols. We normalize by accepting `unknown` options
// and ignoring them when running on native WebSocket.
type AnyWebSocket = {
  binaryType: string;
  readyState: number;
  onopen: ((this: AnyWebSocket) => void) | null;
  onmessage: ((this: AnyWebSocket, event: { data: unknown }) => void) | null;
  onclose:
    | ((this: AnyWebSocket, event: { code: number; reason: string }) => void)
    | null;
  onerror: ((this: AnyWebSocket, event: unknown) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

type WebSocketCtor = new (url: string, options?: unknown) => AnyWebSocket;

let webSocketCtor: WebSocketCtor | null = null;

if (typeof globalThis.WebSocket !== "undefined") {
  // Browser or Node 21+ — use the native global WebSocket.
  // The native constructor's 2nd arg is `protocols` (string | string[]),
  // but we pass an options object which it will simply ignore (it coerces
  // to string, which is then ignored if not a valid protocol).
  // To be safe, we strip the options arg when running on native WebSocket.
  webSocketCtor = class NativeWebSocketWrapper extends globalThis.WebSocket {
    constructor(url: string, _options?: unknown) {
      // Native WebSocket only accepts (url, protocols) — ignore options.
      super(url);
    }
  } as WebSocketCtor;
} else {
  // Node 18-20 without global WebSocket — dynamically import the ws package.
  // Top-level await ensures the import resolves before any code uses
  // webSocketCtor. Bundlers will create a separate chunk for `ws` that's
  // only loaded in this code path (which never runs in a browser).
  try {
    const wsModule = await import("ws");
    webSocketCtor = wsModule.default as unknown as WebSocketCtor;
  } catch {
    // ws package not available — webSocketCtor stays null, and connect()
    // will throw a clear error if called.
  }
}

// ─── UUID helper (Web Crypto) ───

/**
 * Generate a RFC 4122 v4 UUID using the Web Crypto API.
 *
 * Available in Node 18+ (`globalThis.crypto.randomUUID`) and all modern
 * browsers. Falls back to a manual implementation if `randomUUID` is
 * unavailable (extremely rare — only very old runtimes).
 */
function randomUUID(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  // Fallback: manual UUID v4 using getRandomValues
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }
  throw new Error(
    "randomUUID: globalThis.crypto.randomUUID and getRandomValues are both unavailable. " +
      "This requires Node 18+ or a modern browser runtime.",
  );
}

export class YuanbaoWsClient {
  private connectionConfig: WsConnectionConfig;
  private clientConfig: Required<WsClientConfig>;
  private callbacks: WsClientCallbacks;
  private log: ModuleLog;

  private ws: AnyWebSocket | null = null;
  private state: WsClientState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;

  private pendingRequests = new Map<string, PendingRequest>();

  private connectId: string | null = null;

  constructor(params: {
    connection: WsConnectionConfig;
    config?: WsClientConfig;
    callbacks?: WsClientCallbacks;
    log?: Partial<import("../../logger.js").PluginLogger>;
  }) {
    this.connectionConfig = params.connection;
    this.clientConfig = {
      maxReconnectAttempts: params.config?.maxReconnectAttempts ?? 100,
      reconnectDelays:
        params.config?.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS,
    };
    this.callbacks = params.callbacks ?? {};
    this.log = createLog("ws-client", params.log);
  }

  // ─── Connection lifecycle ───

  connect(): void {
    if (this.state !== "disconnected" && this.state !== "reconnecting") {
      this.log.warn(`connect() called in state ${this.state}, ignoring`);
      return;
    }

    this.setState("connecting");
    this.log.info(`connecting to ${this.connectionConfig.gatewayUrl}`);

    try {
      if (!webSocketCtor) {
        throw new Error(
          "No WebSocket constructor available. Under Node 18-20, install the `ws` package. " +
            "Under browser/Node 21+, a global WebSocket is required.",
        );
      }
      // The `ws` package accepts an options object as the 2nd arg; the
      // native browser WebSocket (wrapped in NativeWebSocketWrapper) ignores it.
      this.ws = new webSocketCtor(this.connectionConfig.gatewayUrl, {
        maxPayload: MAX_MESSAGE_SIZE,
      });
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onclose = (event) => this.handleClose(event.code, event.reason);
      this.ws.onerror = (event) => this.handleError(event);
    } catch (err) {
      this.log.error(`WebSocket constructor failed: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.log.info("disconnect() called");
    this.cleanup();
    this.setState("disconnected");
  }

  // ─── Public state ───

  getState(): WsClientState {
    return this.state;
  }

  getConnectId(): string | null {
    return this.connectId;
  }

  // ─── Business API ───

  async sendC2CMessage(
    data: WsSendC2CMessageData,
  ): Promise<WsSendMessageResponse> {
    const bizData = encodeSendC2CMessageReq(data);
    if (!bizData) throw new Error("Failed to encode C2C message request");
    return this.sendBusinessRequest<WsSendMessageResponse>(
      BIZ_CMD.SendC2CMessage,
      bizData,
      (rspData, msgId) => decodeSendMessageRsp(rspData, msgId),
    );
  }

  async sendGroupMessage(
    data: WsSendGroupMessageData,
  ): Promise<WsSendMessageResponse> {
    const bizData = encodeSendGroupMessageReq(data);
    if (!bizData) throw new Error("Failed to encode group message request");
    return this.sendBusinessRequest<WsSendMessageResponse>(
      BIZ_CMD.SendGroupMessage,
      bizData,
      (rspData, msgId) => decodeSendMessageRsp(rspData, msgId),
    );
  }

  async sendPrivateHeartbeat(
    data: WsSendPrivateHeartbeatData,
  ): Promise<WsHeartbeatResponse> {
    const bizData = encodeSendPrivateHeartbeatReq(data);
    if (!bizData) throw new Error("Failed to encode private heartbeat request");
    return this.sendBusinessRequest<WsHeartbeatResponse>(
      BIZ_CMD.SendPrivateHeartbeat,
      bizData,
      (rspData, msgId) => decodeSendPrivateHeartbeatRsp(rspData, msgId),
    );
  }

  async sendGroupHeartbeat(
    data: WsSendGroupHeartbeatData,
  ): Promise<WsHeartbeatResponse> {
    const bizData = encodeSendGroupHeartbeatReq(data);
    if (!bizData) throw new Error("Failed to encode group heartbeat request");
    return this.sendBusinessRequest<WsHeartbeatResponse>(
      BIZ_CMD.SendGroupHeartbeat,
      bizData,
      (rspData, msgId) => decodeSendGroupHeartbeatRsp(rspData, msgId),
    );
  }

  async queryGroupInfo(
    data: WsQueryGroupInfoData,
  ): Promise<WsQueryGroupInfoResponse> {
    const bizData = encodeQueryGroupInfoReq(data);
    if (!bizData) throw new Error("Failed to encode query group info request");
    return this.sendBusinessRequest<WsQueryGroupInfoResponse>(
      BIZ_CMD.QueryGroupInfo,
      bizData,
      (rspData, msgId) => decodeQueryGroupInfoRsp(rspData, msgId),
    );
  }

  async getGroupMemberList(
    data: WsGetGroupMemberListData,
  ): Promise<WsGetGroupMemberListResponse> {
    const bizData = encodeGetGroupMemberListReq(data);
    if (!bizData)
      throw new Error("Failed to encode get group member list request");
    return this.sendBusinessRequest<WsGetGroupMemberListResponse>(
      BIZ_CMD.GetGroupMemberList,
      bizData,
      (rspData, msgId) => decodeGetGroupMemberListRsp(rspData, msgId),
    );
  }

  async syncInformation(
    data: WsSyncInformationData,
  ): Promise<WsSyncInformationResponse> {
    const bizData = encodeSyncInformationReq(data);
    if (!bizData) throw new Error("Failed to encode sync information request");
    return this.sendBusinessRequest<WsSyncInformationResponse>(
      BIZ_CMD.SyncInformation,
      bizData,
      (rspData, msgId) => decodeSyncInformationRsp(rspData, msgId),
    );
  }

  async queryBotInfo(botId: string): Promise<WsQueryBotInfoResponse> {
    const bizData = encodeQueryBotInfoReq(botId);
    if (!bizData) throw new Error("Failed to encode query bot info request");
    return this.sendBusinessRequest<WsQueryBotInfoResponse>(
      BIZ_CMD.QueryBotInfo,
      bizData,
      (rspData, msgId) => decodeQueryBotInfoRsp(rspData, msgId),
    );
  }

  // ─── Internal handlers ───

  private handleOpen(): void {
    this.log.info("WebSocket connected, sending auth-bind");
    this.setState("authenticating");

    const msgId = randomUUID();
    const authMsg = buildAuthBindMsg({
      bizId: this.connectionConfig.auth.bizId,
      uid: this.connectionConfig.auth.uid,
      source: this.connectionConfig.auth.source,
      token: this.connectionConfig.auth.token,
      msgId,
      routeEnv: this.connectionConfig.auth.routeEnv,
      appVersion: "1.0.0",
      operationSystem: "Linux",
    });

    if (!authMsg) {
      this.log.error("Failed to build auth-bind message");
      this.scheduleReconnect();
      return;
    }

    this.sendRaw(authMsg);

    // Auth timeout
    setTimeout(() => {
      if (this.state === "authenticating") {
        this.log.error("Auth-bind timeout");
        this.scheduleReconnect();
      }
    }, AUTH_TIMEOUT_MS);
  }

  private handleMessage(event: { data: unknown }): void {
    let rawData: ArrayBuffer | Uint8Array;

    if (event.data instanceof ArrayBuffer) {
      rawData = event.data;
    } else if (typeof Buffer !== "undefined" && event.data instanceof Buffer) {
      // Node Buffer (from the `ws` package) — wrap as Uint8Array view.
      // `Buffer` is undefined in browser; the `typeof Buffer !== "undefined"`
      // guard prevents a ReferenceError under browser.
      rawData = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      );
    } else if (typeof event.data === "string") {
      // Text frame — unusual but handle gracefully
      this.log.debug("received text frame (unexpected), ignoring");
      return;
    } else if (event.data instanceof Uint8Array) {
      rawData = event.data;
    } else {
      // Unknown — try to coerce as ArrayBuffer
      rawData = new Uint8Array(event.data as unknown as ArrayBuffer);
    }

    const connMsg = decodeConnMsg(rawData);
    if (!connMsg?.head) {
      this.log.warn("failed to decode ConnMsg from WebSocket frame");
      return;
    }

    const { head, data } = connMsg;
    this.log.debug(
      `received: cmd=${head.cmd}, cmdType=${head.cmdType}, seqNo=${head.seqNo}`,
    );

    switch (head.cmdType) {
      case CMD_TYPE.Response:
        this.handleResponse(head, data);
        break;
      case CMD_TYPE.Push:
        this.handlePush(head, data);
        break;
      case CMD_TYPE.PushAck:
        // Acknowledged — no action needed
        break;
      default:
        this.log.debug(`unknown cmdType=${head.cmdType}, cmd=${head.cmd}`);
    }
  }

  private handleResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    // Auth-bind response
    if (head.cmd === CMD.AuthBind) {
      this.handleAuthBindResponse(head, data);
      return;
    }

    // Ping response
    if (head.cmd === CMD.Ping) {
      this.clearPingTimeout();
      return;
    }

    // Business response — match to pending request
    const pending = this.pendingRequests.get(head.msgId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(head.msgId);
      pending.resolve(data);
    } else {
      this.log.debug(
        `response for unknown msgId=${head.msgId}, cmd=${head.cmd}`,
      );
    }
  }

  private handleAuthBindResponse(
    head: PBConnMsg["head"],
    data: Uint8Array,
  ): void {
    if (head.status !== undefined && head.status !== 0) {
      this.log.error(`auth-bind failed: status=${head.status}`);
      // Notify callback for auth retry
      if (this.callbacks.onAuthFailed) {
        this.callbacks
          .onAuthFailed(head.status ?? -1)
          .then((newAuth) => {
            if (newAuth) {
              this.connectionConfig.auth = newAuth;
              this.handleOpen(); // Retry auth
            } else {
              this.scheduleReconnect();
            }
          })
          .catch(() => {
            this.scheduleReconnect();
          });
      } else {
        this.scheduleReconnect();
      }
      return;
    }

    // Parse auth-bind response
    const rspData = decodePB(PB_MSG_TYPES.AuthBindRsp, data) as {
      connectId?: string;
      timestamp?: number;
      clientIp?: string;
    } | null;

    this.connectId = rspData?.connectId ?? randomUUID();
    this.reconnectAttempts = 0;

    this.log.info(`auth-bind success: connectId=${this.connectId}`);
    this.setState("connected");
    this.startPing();

    this.callbacks.onReady?.({
      connectId: this.connectId,
      timestamp: rspData?.timestamp ?? Date.now(),
      clientIp: rspData?.clientIp ?? "",
    });
  }

  private handlePush(head: PBConnMsg["head"], data: Uint8Array): void {
    // Send ACK
    const ack = buildPushAck(head);
    if (ack) {
      this.sendRaw(ack);
    }

    // Kickout
    if (head.cmd === CMD.Kickout) {
      const kickData = decodePB(PB_MSG_TYPES.KickoutMsg, data) as {
        status?: number;
        reason?: string;
        otherDeviceName?: string;
      } | null;

      this.log.warn(
        `kickout: status=${kickData?.status}, reason=${kickData?.reason}`,
      );
      this.callbacks.onKickout?.({
        status: kickData?.status ?? 0,
        reason: kickData?.reason ?? "",
        otherDeviceName: kickData?.otherDeviceName,
      });
      this.scheduleReconnect();
      return;
    }

    // DirectedPush or PushMsg — dispatch to callback
    let pushEvent: WsPushEvent;

    const directed = decodePB(PB_MSG_TYPES.DirectedPush, data) as {
      type?: number;
      content?: string;
      data?: Uint8Array;
    } | null;

    if (directed) {
      pushEvent = {
        type: directed.type,
        content: directed.content,
        rawData: directed.data,
        connData: data,
        cmd: head.cmd,
        module: head.module,
        msgId: head.msgId,
      };
    } else {
      const pushMsg = decodePB(PB_MSG_TYPES.PushMsg, data) as {
        type?: number;
        content?: string;
        data?: Uint8Array;
      } | null;

      pushEvent = {
        type: pushMsg?.type,
        content: pushMsg?.content,
        rawData: pushMsg?.data,
        connData: data,
        cmd: head.cmd,
        module: head.module,
        msgId: head.msgId,
      };
    }

    this.callbacks.onDispatch?.(pushEvent);
  }

  private handleClose(code: number, reason: string | Buffer): void {
    const reasonStr =
      typeof reason === "string" ? reason : reason.toString("utf-8");
    this.log.info(`WebSocket closed: code=${code}, reason=${reasonStr}`);
    this.callbacks.onClose?.(code, reasonStr);
    this.cleanupConnection();
    this.scheduleReconnect();
  }

  private handleError(_event: unknown): void {
    this.log.error("WebSocket error");
    // onclose will fire after onerror, so reconnection is handled there
  }

  // ─── Business request with timeout ───

  private sendBusinessRequest<T>(
    cmd: string,
    bizData: Uint8Array,
    decoder: (data: Uint8Array, msgId: string) => T | null,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.state !== "connected") {
        reject(
          new Error(`Cannot send ${cmd}: not connected (state=${this.state})`),
        );
        return;
      }

      const msgId = randomUUID();
      const connMsg = buildBusinessConnMsg(cmd, BIZ_MODULE, bizData, msgId);

      if (!connMsg) {
        reject(new Error(`Failed to build business message for ${cmd}`));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(msgId);
        reject(new Error(`Business request ${cmd} timed out (msgId=${msgId})`));
      }, BUSINESS_TIMEOUT_MS);

      this.pendingRequests.set(msgId, {
        resolve: (rspData: unknown) => {
          const decoded = decoder(rspData as Uint8Array, msgId);
          if (decoded) {
            resolve(decoded);
          } else {
            reject(new Error(`Failed to decode response for ${cmd}`));
          }
        },
        reject,
        timer,
      });

      this.sendRaw(connMsg);
    });
  }

  // ─── Ping / heartbeat ───

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.state !== "connected") return;
      const msgId = randomUUID();
      const pingMsg = buildPingMsg(msgId);
      if (pingMsg) {
        this.sendRaw(pingMsg);
        this.pingTimeout = setTimeout(() => {
          this.log.warn("ping timeout, closing connection");
          this.ws?.close(4000, "ping timeout");
        }, PING_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPingTimeout();
  }

  private clearPingTimeout(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  // ─── Reconnection ───

  private scheduleReconnect(): void {
    this.cleanupConnection();

    if (this.reconnectAttempts >= this.clientConfig.maxReconnectAttempts) {
      this.log.error(
        `max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) reached`,
      );
      this.setState("disconnected");
      return;
    }

    this.setState("reconnecting");

    const delayIdx = Math.min(
      this.reconnectAttempts,
      this.clientConfig.reconnectDelays.length - 1,
    );
    const delay = this.clientConfig.reconnectDelays[delayIdx];
    this.reconnectAttempts++;

    this.log.info(
      `reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.clientConfig.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ─── Cleanup ───

  private cleanup(): void {
    this.cleanupConnection();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
  }

  private cleanupConnection(): void {
    this.stopPing();
    if (this.ws) {
      // Remove all listeners to prevent double-fire
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  // ─── Send raw binary ───

  private sendRaw(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn("sendRaw called but WebSocket not open");
      return;
    }
    this.ws.send(data);
  }

  // ─── State management ───

  private setState(newState: WsClientState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      this.log.info(`state: ${oldState} -> ${newState}`);
      this.callbacks.onStateChange?.(newState);
    }
  }
}
