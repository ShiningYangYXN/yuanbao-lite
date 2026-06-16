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

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, dirname } from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, ImImageInfoArrayItem, YuanbaoMsgBodyElement } from "../../types.js";
import { getAuthHeaders, yuanbaoPost, yuanbaoGet } from "./request.js";

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
async function apiGetDownloadUrl(
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
  const signTime = `${config.startTime || Math.floor(Date.now() / 1000)};${config.expiredTime || Math.floor(Date.now() / 1000) + 3600}`;
  const keyTime = signTime;
  const signKey = createHmac("sha1", secretKey).update(keyTime).digest("hex");

  // httpString: METHOD\nPATH\nQUERY\nHEADERS
  const cosPath = config.location;
  const httpString = `put\n${cosPath}\n\nhost=${host}\n`;
  const stringToSign = `sha1\n${signTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");

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
    throw new Error(`COS PUT error: ${(err as Error).message}`);
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

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = statSync(filePath);
  const fileSizeMB = fileStat.size / (1024 * 1024);
  const maxSizeMB = account.mediaMaxMb || MAX_FILE_SIZE_MB;

  if (fileSizeMB > maxSizeMB) {
    throw new Error(`File too large: ${fileSizeMB.toFixed(1)}MB exceeds limit of ${maxSizeMB}MB`);
  }

  const fileName = basename(filePath);
  const mediaType = detectMediaType(filePath, options?.mediaType);

  log.info(`uploading (COS): ${fileName} (${fileSizeMB.toFixed(1)}MB, type=${mediaType})`);

  // Read file content
  const fileBuffer = await readFile(filePath);
  const fileId = randomBytes(16).toString("hex");
  const uuid = createHash("md5").update(fileBuffer).digest("hex");
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

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = statSync(filePath);
  const fileName = basename(filePath);
  const mediaType = detectMediaType(filePath, options?.mediaType);

  log.info(`uploading (legacy): ${fileName}`);

  const fileBuffer = await readFile(filePath);
  const boundary = `----FormBoundary${randomBytes(8).toString("hex")}`;
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
  const targetDir = saveDir || join(process.cwd(), "downloads");

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  log.info(`downloading: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const finalFileName = fileName || extractFileNameFromUrl(url) || `media_${Date.now()}`;
  const filePath = join(targetDir, finalFileName);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await writeFile(filePath, buffer);

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
