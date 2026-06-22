/**
 * Media upload and download functionality.
 *
 * Provides file upload via COS (Tencent Cloud Object Storage) and download of
 * media attachments from messages, restored from the original
 * openclaw-plugin-yuanbao media module.
 *
 * Upload flow (matches the original project):
 * 1. Call /api/resource/genUploadInfo to get COS pre-signed config
 * 2. Upload the file to COS using the pre-signed URL
 * 3. Use the resourceUrl in the message body
 *
 * Fallback: If COS upload fails, falls back to the old /api/v5/robotLogic/upload endpoint.
 */

import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import { getAuthHeaders, yuanbaoPost, yuanbaoGet } from "./request.js";
import { getNodeModules } from "../persistence/adapter.js";

// ─── Web Crypto helpers (browser-safe) ───

/**
 * Encode a UTF-8 string as Uint8Array via TextEncoder (universal).
 */
function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Compute SHA-1 hash of a string, returning hex.
 * Uses Web Crypto API (available in Node 18+ and all modern browsers).
 */
async function sha1Hex(input: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-1", encodeUtf8(input) as BufferSource);
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Compute MD5 hash of a Uint8Array, returning hex.
 *
 * Web Crypto API does NOT support MD5 (deliberately — it's broken for
 * security-sensitive use). We use a pure-JS MD5 implementation for
 * compatibility with Tencent's COS upload protocol, which still requires
 * MD5 for file deduplication.
 *
 * Implementation: a minimal RFC 1321 MD5 — small, dependency-free, and
 * fast enough for the upload path (called once per file upload).
 *
 * Marked `async` for API consistency with the other Web Crypto helpers
 * (sha1Hex, hmacSha1Hex) — the implementation is actually synchronous
 * but may be made async in the future if we switch to a worker-based impl.
 */
async function md5Hex(data: Uint8Array): Promise<string> {
  return pureJsMd5Hex(data);
}

/**
 * Compute HMAC-SHA1 with the given key and message, returning hex.
 * Uses Web Crypto API.
 */
async function hmacSha1Hex(key: string, message: string): Promise<string> {
  const keyBytes = encodeUtf8(key);
  const msgBytes = encodeUtf8(message);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, msgBytes as BufferSource);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Generate cryptographically random hex of the given byte length.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ─── Path helpers (use Node modules when available, pure-JS fallback) ───

/**
 * Get the file extension (including the leading dot, lowercased).
 *
 * Uses `node:path.extname` under Node; falls back to a pure-JS impl
 * under browser (sufficient for filename parsing).
 */
function extname(filename: string): string {
  const path = getNodeModules().path;
  if (path) return path.extname(filename).toLowerCase();
  // Pure-JS fallback: last dot after last slash
  const lastSlash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= lastSlash) return "";
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Get the basename of a path (filename without directory, with extension).
 *
 * Uses `node:path.basename` under Node; falls back to pure-JS.
 */
function basename(filePath: string): string {
  const path = getNodeModules().path;
  if (path) return path.basename(filePath);
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return filePath.slice(lastSlash + 1);
}

// ─── Pure-JS MD5 implementation (RFC 1321) ───
//
// Web Crypto API does not support MD5. Tencent's COS upload protocol
// requires MD5 for file deduplication (the `uuid` field is the MD5 of
// the file content). We implement MD5 here in pure JS to avoid pulling
// in a third-party dependency and to keep the module browser-compatible.
//
// This implementation is not constant-time and should NOT be used for
// security-sensitive purposes. It's only used for content-addressable
// file IDs, which is MD5's appropriate use case.

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function pureJsMd5Hex(data: Uint8Array): string {
  // Pre-processing: adding a single 1 bit, then padding with 0s to (len ≡ 448 mod 512) bits, then append original length as 64-bit LE.
  const originalBitLen = BigInt(data.length) * 8n;
  const withOneBit = new Uint8Array(data.length + 1);
  withOneBit.set(data);
  withOneBit[data.length] = 0x80;

  // Pad to (len ≡ 56 mod 64) bytes
  const padLen = (56 - (withOneBit.length % 64) + 64) % 64;
  const padded = new Uint8Array(withOneBit.length + padLen + 8);
  padded.set(withOneBit);
  // Append 64-bit LE length
  const lenView = new DataView(padded.buffer, padded.length - 8, 8);
  // Use BigInt to write 64-bit LE — DataView doesn't have setBigUint64 in older runtimes, so write two 32-bit halves.
  const lenLo = Number(originalBitLen & 0xffffffffn);
  const lenHi = Number((originalBitLen >> 32n) & 0xffffffffn);
  lenView.setUint32(0, lenLo, true);
  lenView.setUint32(4, lenHi, true);

  // Initialize hash state
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  // Process each 512-bit (64-byte) chunk
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    const dv = new DataView(padded.buffer, off, 64);
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(i * 4, true);
    }

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // Output as little-endian hex
  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0, true);
  outDv.setUint32(4, b0, true);
  outDv.setUint32(8, c0, true);
  outDv.setUint32(12, d0, true);
  return bytesToHex(out);
}

// ─── Types ───

export type MediaType = "image" | "file" | "video" | "audio" | "sticker";

export type UploadResult = {
  /** UUID of the uploaded file on Yuanbao's server */
  uuid: string;
  /** Download URL of the uploaded file */
  url: string;
  /** File size in bytes */
  fileSize: number;
  /** Media type */
  mediaType: MediaType;
  /** Original file name */
  fileName: string;
  /** Resource ID (from COS upload) */
  resourceId?: string;
  /** Image dimensions */
  imageInfo?: { width: number; height: number };
};

export type DownloadResult = {
  /** Local file path where the file was saved */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Media type */
  mediaType: MediaType;
  /** Original file name */
  fileName: string;
};

export type MediaInfo = {
  /** Extracted image URL from message body */
  imageUrl?: string;
  /** File download URL */
  fileUrl?: string;
  /** File name */
  fileName?: string;
  /** File size */
  fileSize?: number;
  /** Media type */
  mediaType: MediaType;
  /** UUID of the media resource */
  uuid?: string;
  /** Image dimensions */
  width?: number;
  height?: number;
};

// ─── COS Upload Config ───

type CosUploadConfig = {
  bucketName: string;
  region: string;
  location: string;
  resourceUrl: string;
  resourceID: string;
  /** Pre-signed upload URL (if available) */
  uploadUrl?: string;
  /** Temp upload URL (if available) */
  tempUploadUrl?: string;
  /** COS URL (if available) */
  cosURL?: string;
  /** COS credentials (plain-text) */
  tmpSecretId?: string;
  tmpSecretKey?: string;
  sessionToken?: string;
  /** COS credentials (encrypted — actually usable as-is) */
  encryptTmpSecretId?: string;
  encryptTmpSecretKey?: string;
  encryptToken?: string;
  startTime?: number;
  expiredTime?: number;
  /** Accelerate config */
  supportAccelerate?: boolean;
  accelerateDomain?: string;
  /** Full COS config JSON from server */
  [key: string]: unknown;
};

// ─── Constants ───

const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
const DOWNLOAD_INFO_PATH = "/api/resource/v1/download";
const LEGACY_UPLOAD_PATH = "/api/v5/robotLogic/upload";
const MAX_FILE_SIZE_MB = 20;

// ─── Media type detection ───

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"]);

function detectMediaType(filePath: string, forceType?: MediaType): MediaType {
  if (forceType) return forceType;
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "file";
}

/** Guess MIME type from filename extension */
function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mime: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".pdf": "application/pdf", ".txt": "text/plain", ".zip": "application/zip",
    ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav",
  };
  return mime[ext] ?? "application/octet-stream";
}

/** Parse image dimensions from Buffer (supports JPEG/PNG/GIF/WebP) */
function parseImageSize(buf: Buffer): { width: number; height: number } | undefined {
  return parsePngSize(buf) ?? parseJpegSize(buf) ?? parseGifSize(buf) ?? parseWebpSize(buf);
}

function parsePngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (i + 3 < buf.length) { i += 2 + buf.readUInt16BE(i + 2); } else { break; }
  }
  return undefined;
}

function parseGifSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 10) return undefined;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseWebpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 16) return undefined;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && buf.length >= 30) {
    return {
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
    };
  }
  return undefined;
}

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
}

// ─── Extract media info from message body ───

export function extractMediaInfo(msgBody: YuanbaoMsgBodyElement[]): MediaInfo[] {
  const results: MediaInfo[] = [];

  for (const el of msgBody) {
    const content = el.msg_content;
    if (!content) continue;

    switch (el.msg_type) {
      case "TIMImageElem": {
        const images: MediaInfo = {
          mediaType: "image",
          uuid: content.uuid,
          fileName: content.desc || "image",
          width: content.image_info_array?.[0]?.width,
          height: content.image_info_array?.[0]?.height,
        };

        if (content.image_info_array && content.image_info_array.length > 0) {
          const sorted = [...content.image_info_array].sort((a, b) => (b.type ?? 0) - (a.type ?? 0));
          images.imageUrl = sorted[0].url;
        }

        results.push(images);
        break;
      }

      case "TIMFileElem": {
        results.push({
          mediaType: "file",
          uuid: content.uuid,
          fileName: content.file_name || "file",
          fileSize: content.file_size,
          fileUrl: content.url,
        });
        break;
      }

      case "TIMVideoElem": {
        results.push({
          mediaType: "video",
          uuid: content.uuid,
          fileName: content.desc || "video",
          fileSize: content.file_size,
          fileUrl: content.url,
        });
        break;
      }

      case "TIMSoundElem": {
        results.push({
          mediaType: "audio",
          uuid: content.uuid,
          fileName: content.desc || "audio",
          fileSize: content.file_size,
          fileUrl: content.url,
        });
        break;
      }

      case "TIMFaceElem": {
        results.push({
          mediaType: "sticker",
          fileName: `emoji_${content.index ?? 0}`,
        });
        break;
      }
    }
  }

  return results;
}

/**
 * Build a TIMImageElem msg_body for sending an image.
 *
 * Uses image_format=255 as in the original project.
 */
export function buildImageMsgBody(params: {
  uuid: string;
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMImageElem",
      msg_content: {
        uuid: params.uuid,
        image_format: 255,
        image_info_array: [
          {
            type: 1,
            size: params.size ?? 0,
            width: params.width ?? 0,
            height: params.height ?? 0,
            url: params.url ?? "",
          },
        ],
      },
    },
  ];
}

/**
 * Build a TIMFileElem msg_body for sending a file.
 */
export function buildFileMsgBody(params: {
  uuid: string;
  fileName: string;
  fileSize: number;
  url?: string;
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMFileElem",
      msg_content: {
        uuid: params.uuid,
        file_name: params.fileName,
        file_size: params.fileSize,
        url: params.url ?? "",
      },
    },
  ];
}

// ─── COS Upload (primary method) ───

/**
 * Get COS upload pre-sign config from Yuanbao API.
 */
async function apiGetUploadInfo(
  account: ResolvedYuanbaoAccount,
  fileName: string,
  fileId: string,
): Promise<CosUploadConfig> {
  const data = await yuanbaoPost<CosUploadConfig>(
    account,
    UPLOAD_INFO_PATH,
    { fileName, fileId, docFrom: "localDoc", docOpenId: "" },
  );

  if (!data.bucketName || !data.location) {
    throw new Error(`genUploadInfo incomplete config: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Get COS download URL for a given resourceId.
 */
export async function apiGetDownloadUrl(
  account: ResolvedYuanbaoAccount,
  resourceId: string,
): Promise<string> {
  const data = await yuanbaoGet<{ url?: string; realUrl?: string }>(
    account,
    DOWNLOAD_INFO_PATH,
    { resourceId },
  );

  const downloadUrl = data.url ?? data.realUrl;
  if (!downloadUrl) {
    throw new Error(`resource/v1/download returned no valid URL: ${JSON.stringify(data)}`);
  }

  return downloadUrl;
}

/**
 * Upload a file buffer to COS using the pre-signed config.
 *
 * This uses the same approach as the original project:
 * 1. Get pre-signed config from /api/resource/genUploadInfo
 * 2. PUT the file to COS using the credentials
 */
async function uploadBufferToCos(params: {
  config: CosUploadConfig;
  data: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string> {
  const { config, data, filename, mimeType } = params;
  const log = createLog("media-cos");

  // Resolve COS credentials — prefer encrypted (actually usable as-is) over plain
  const secretId = config.encryptTmpSecretId || config.tmpSecretId;
  const secretKey = config.encryptTmpSecretKey || config.tmpSecretKey;
  const sessionToken = config.encryptToken || config.sessionToken;

  if (!secretId || !secretKey) {
    throw new Error("COS upload: no credentials available (missing secretId/secretKey)");
  }

  // Build COS upload URL — use standard domain (accelerate domain may have DNS issues)
  const host = `${config.bucketName}.cos.${config.region}.myqcloud.com`;

  const cosUrl = `https://${host}${config.location}`;

  // Build COS Authorization header using HMAC-SHA1 signing (v1 signature)
  // Uses Web Crypto API (async) — works in both Node 18+ and browsers.
  const signTime = `${config.startTime || Math.floor(Date.now() / 1000)};${config.expiredTime || Math.floor(Date.now() / 1000) + 3600}`;
  const keyTime = signTime;
  const signKey = await hmacSha1Hex(secretKey, keyTime);

  // httpString: METHOD\nPATH\nQUERY\nHEADERS
  const cosPath = config.location;
  const httpString = `put\n${cosPath}\n\nhost=${host}\n`;
  const httpStringHash = await sha1Hex(httpString);
  const stringToSign = `sha1\n${signTime}\n${httpStringHash}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const authorization = `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;

  const headers: Record<string, string> = {
    "Authorization": authorization,
    "Host": host,
  };

  if (isImageFile(filename)) {
    headers["Content-Type"] = mimeType || `image/${extname(filename).slice(1)}`;
    headers["Pic-Operations"] = JSON.stringify({
      is_pic_info: 1,
      rules: [{ fileid: config.location, rule: "imageMogr2/format/jpg" }],
    });
  } else {
    headers["Content-Type"] = "application/octet-stream";
  }

  // Add session token (required for temporary credentials)
  if (sessionToken) {
    headers["x-cos-security-token"] = sessionToken;
  }

  log.info(`uploading to COS: ${cosUrl} (${data.length} bytes)`);

  try {
    const response = await fetch(cosUrl, {
      method: "PUT",
      headers,
      body: new Uint8Array(data),
    });

    if (response.ok) {
      log.info(`COS upload success: ${config.resourceUrl}`);
      return config.resourceUrl;
    }

    const errorBody = await response.text().catch(() => "");
    throw new Error(`COS PUT failed: HTTP ${response.status} — ${errorBody.substring(0, 200)}`);
  } catch (err) {
    if ((err as Error).message.startsWith("COS PUT failed")) {
      throw err;
    }
    throw new Error(`COS PUT error: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Upload a file to COS (primary upload method).
 *
 * Follows the original project's upload flow:
 * 1. Get COS pre-signed config from /api/resource/genUploadInfo
 * 2. Upload file to COS
 * 3. Return upload result with resource URL
 */
export async function uploadMediaToCos(
  account: ResolvedYuanbaoAccount,
  filePath: string,
  options?: {
    mediaType?: MediaType;
    onProgress?: (uploaded: number, total: number) => void;
  },
): Promise<UploadResult> {
  const log = createLog("media-upload");

  // File system access — Node-only. Under browser, callers must provide
  // the file content directly via a different code path (TODO: add a
  // Blob/File-based uploadMedia overload for browsers).
  const { fs, path } = getNodeModules();
  if (!fs || !path) {
    throw new Error(
      "uploadMedia requires Node.js runtime (node:fs, node:path) to read local files. " +
        "Browser callers should use uploadMediaBuffer() with a Uint8Array instead.",
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = fs.statSync(filePath);
  const fileSizeMB = fileStat.size / (1024 * 1024);
  const maxSizeMB = account.mediaMaxMb || MAX_FILE_SIZE_MB;

  if (fileSizeMB > maxSizeMB) {
    throw new Error(`File too large: ${fileSizeMB.toFixed(1)}MB exceeds limit of ${maxSizeMB}MB`);
  }

  const fileName = basename(filePath);
  const mediaType = detectMediaType(filePath, options?.mediaType);

  log.info(`uploading (COS): ${fileName} (${fileSizeMB.toFixed(1)}MB, type=${mediaType})`);

  // Read file content
  const fileBuffer = await fs.promises.readFile(filePath);
  const fileId = randomHex(16);
  const uuid = await md5Hex(new Uint8Array(fileBuffer));
  const imageInfo = mediaType === "image" ? parseImageSize(fileBuffer) : undefined;
  const mimeType = guessMimeType(fileName);

  // 1. Get COS pre-signed config
  const cosConfig = await apiGetUploadInfo(account, fileName, fileId);

  // 2. Upload to COS
  const url = await uploadBufferToCos({
    config: cosConfig,
    data: fileBuffer,
    filename: fileName,
    mimeType,
  });

  options?.onProgress?.(fileStat.size, fileStat.size);

  log.info(`COS upload success: uuid=${uuid}, url=${url ? "received" : "pending"}`);

  return {
    uuid,
    url,
    fileSize: fileStat.size,
    mediaType,
    fileName,
    resourceId: cosConfig.resourceID,
    imageInfo,
  };
}

/**
 * Legacy upload using /api/v5/robotLogic/upload endpoint.
 * Used as fallback when COS upload is not available.
 */
async function uploadMediaLegacy(
  account: ResolvedYuanbaoAccount,
  filePath: string,
  options?: {
    mediaType?: MediaType;
    onProgress?: (uploaded: number, total: number) => void;
  },
): Promise<UploadResult> {
  const log = createLog("media-upload-legacy");

  // File system access — Node-only (same as uploadMedia).
  const { fs, path } = getNodeModules();
  if (!fs || !path) {
    throw new Error(
      "uploadMediaLegacy requires Node.js runtime (node:fs, node:path) to read local files.",
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = fs.statSync(filePath);
  const fileName = basename(filePath);
  const mediaType = detectMediaType(filePath, options?.mediaType);

  log.info(`uploading (legacy): ${fileName}`);

  const fileBuffer = await fs.promises.readFile(filePath);
  const boundary = `----FormBoundary${randomHex(8)}`;
  const formData = buildMultipartFormData(boundary, fileBuffer, fileName, mediaType);

  const authHeaders = await getAuthHeaders(account);
  const url = `https://${account.apiDomain}${LEGACY_UPLOAD_PATH}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...authHeaders,
    },
    body: Buffer.from(formData),
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as {
    code: number;
    data?: { uuid?: string; url?: string; file_size?: number };
    msg?: string;
  };

  if (result.code !== 0) {
    throw new Error(`Upload failed: code=${result.code}, msg=${result.msg}`);
  }

  return {
    uuid: result.data?.uuid || "",
    url: result.data?.url || "",
    fileSize: fileStat.size,
    mediaType,
    fileName,
  };
}

/**
 * Upload a file to Yuanbao's media server.
 *
 * Tries COS upload first, falls back to legacy upload on failure.
 */
export async function uploadMedia(
  account: ResolvedYuanbaoAccount,
  filePath: string,
  options?: {
    mediaType?: MediaType;
    onProgress?: (uploaded: number, total: number) => void;
  },
): Promise<UploadResult> {
  const log = createLog("media-upload");

  try {
    return await uploadMediaToCos(account, filePath, options);
  } catch (cosError) {
    log.warn(`COS upload failed: ${(cosError as Error).message}, trying legacy upload`);
    try {
      return await uploadMediaLegacy(account, filePath, options);
    } catch (legacyError) {
      log.error(`Legacy upload also failed: ${(legacyError as Error).message}`);
      throw legacyError;
    }
  }
}

/**
 * Build multipart form data body for file upload (legacy).
 */
function buildMultipartFormData(
  boundary: string,
  fileBuffer: Buffer,
  fileName: string,
  mediaType: MediaType,
): Uint8Array {
  const encoder = new TextEncoder();

  const fieldName = mediaType === "image" ? "image" :
    mediaType === "video" ? "video" :
    mediaType === "audio" ? "audio" :
    "file";

  const parts: Uint8Array[] = [];

  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  parts.push(encoder.encode(header));
  parts.push(fileBuffer);

  const typePart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mediaType}`;
  parts.push(encoder.encode(typePart));

  const closing = `\r\n--${boundary}--\r\n`;
  parts.push(encoder.encode(closing));

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

// ─── Download ───

export async function downloadMedia(
  url: string,
  saveDir?: string,
  fileName?: string,
): Promise<DownloadResult> {
  const log = createLog("media-download");
  // File system access — Node-only. Under browser, callers should use
  // the returned buffer directly (TODO: split into downloadMediaBuffer()
  // for browser and downloadMedia() for Node).
  const { fs, path } = getNodeModules();
  if (!fs || !path) {
    throw new Error(
      "downloadMedia requires Node.js runtime (node:fs, node:path) to write local files. " +
        "Browser callers should fetch the URL directly and handle the Blob.",
    );
  }
  const targetDir = saveDir || path.join(process.cwd(), "downloads");

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  log.info(`downloading: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const finalFileName = fileName || extractFileNameFromUrl(url) || `media_${Date.now()}`;
  const filePath = path.join(targetDir, finalFileName);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(filePath, buffer);

  log.info(`downloaded: ${filePath} (${buffer.length} bytes)`);

  return {
    filePath,
    fileSize: buffer.length,
    mediaType: detectMediaType(finalFileName),
    fileName: finalFileName,
  };
}

export async function downloadAllMedia(
  msgBody: YuanbaoMsgBodyElement[],
  saveDir?: string,
): Promise<DownloadResult[]> {
  const mediaInfos = extractMediaInfo(msgBody);
  const results: DownloadResult[] = [];

  for (const info of mediaInfos) {
    const url = info.imageUrl || info.fileUrl;
    if (!url) continue;

    try {
      const result = await downloadMedia(url, saveDir, info.fileName);
      results.push(result);
    } catch (err) {
      createLog("media-download").error(`failed to download ${url}: ${(err as Error).message}`);
    }
  }

  return results;
}

// ─── Helpers ───

function extractFileNameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    if (pathSegments.length > 0) {
      return decodeURIComponent(pathSegments[pathSegments.length - 1]);
    }
  } catch {
    // Not a valid URL
  }
  return null;
}
