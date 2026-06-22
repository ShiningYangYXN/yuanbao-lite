/**
 * GoFile temporary file upload utility.
 *
 * Uploads files to GoFile (gofile.io) for free temporary file sharing.
 * Returns a direct download link that can be sent as a text message
 * in group/private chats.
 *
 * This is used as an alternative to direct file sending (TIMFileElem)
 * which may not work reliably in some IM clients.
 */

import { createLog } from "../../logger.js";
import type { TempFileProvider, TempFileUploadResult } from "./tempfile.js";
import { getNodeModules } from "../persistence/adapter.js";

// ─── Path helper (browser-safe) ───

/**
 * Get the basename of a path. Uses `node:path.basename` under Node,
 * falls back to pure-JS under browser.
 */
function basename(filePath: string): string {
  const path = getNodeModules().path;
  if (path) return path.basename(filePath);
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  return filePath.slice(lastSlash + 1);
}

// ─── Types ───

export type GoFileUploadResult = {
  /** GoFile download page URL */
  pageUrl: string;
  /** Direct download URL (if available) */
  directUrl: string;
  /** GoFile file ID */
  fileId: string;
  /** File name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
};

// ─── Constants ───

const GOFILE_UPLOAD_SERVER = "https://store1.gofile.io/uploadFile";
const MAX_FILE_SIZE_MB = 500; // GoFile free tier limit

// ─── Upload ───

/**
 * Upload a file to GoFile for temporary sharing.
 *
 * Uses the GoFile store API endpoint directly.
 *
 * @param filePath - Local file path to upload
 * @returns Upload result with download URLs
 */
export async function uploadToGoFile(
  filePath: string,
): Promise<GoFileUploadResult> {
  const log = createLog("gofile");

  // File system access — Node-only. Under browser, callers must provide
  // file content directly via a different code path.
  const { fs } = getNodeModules();
  if (!fs) {
    throw new Error(
      "uploadToGoFile requires Node.js runtime (node:fs) to read local files.",
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = fs.statSync(filePath);
  const fileSizeMB = fileStat.size / (1024 * 1024);

  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    throw new Error(
      `File too large: ${fileSizeMB.toFixed(1)}MB exceeds GoFile limit of ${MAX_FILE_SIZE_MB}MB`,
    );
  }

  const fileName = basename(filePath);
  log.info(`uploading to GoFile: ${fileName} (${fileSizeMB.toFixed(1)}MB)`);

  // Read file content
  const fileBuffer = await fs.promises.readFile(filePath);

  // Build multipart form data
  const boundary = `----GoFileBoundary${Date.now()}`;
  const formData = buildMultipart(boundary, fileBuffer, fileName);

  // Upload to GoFile
  const uploadResp = await fetch(GOFILE_UPLOAD_SERVER, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.from(formData),
  });

  if (!uploadResp.ok) {
    throw new Error(`GoFile upload failed: HTTP ${uploadResp.status}`);
  }

  const uploadData = (await uploadResp.json()) as {
    status: string;
    data?: {
      id?: string;
      name?: string;
      size?: number;
      downloadPage?: string;
      directLink?: string;
      parentFolderCode?: string;
    };
  };

  if (uploadData.status !== "ok" || !uploadData.data) {
    throw new Error(`GoFile upload failed: ${JSON.stringify(uploadData)}`);
  }

  const result: GoFileUploadResult = {
    pageUrl:
      uploadData.data.downloadPage ||
      `https://gofile.io/d/${uploadData.data.parentFolderCode || ""}`,
    directUrl: uploadData.data.directLink || "",
    fileId: uploadData.data.id || "",
    fileName: uploadData.data.name || fileName,
    fileSize: uploadData.data.size || fileStat.size,
  };

  log.info(`GoFile upload success: ${result.pageUrl}`);

  return result;
}

/**
 * Upload a file and return a formatted share link message.
 */
export async function uploadAndFormatLink(
  filePath: string,
  description?: string,
): Promise<string> {
  const result = await uploadToGoFile(filePath);

  const desc = description ? ` (${description})` : "";
  const sizeStr =
    result.fileSize > 1024 * 1024
      ? `${(result.fileSize / (1024 * 1024)).toFixed(1)}MB`
      : `${(result.fileSize / 1024).toFixed(0)}KB`;

  return `文件分享${desc}: ${result.fileName} [${sizeStr}]\n链接: ${result.pageUrl}`;
}

// ─── Helpers ───

/**
 * GoFile provider as a TempFileProvider-compatible object.
 *
 * This allows the gofile provider to be used interchangeably with other
 * temp file providers from the tempfile module.
 */
export const goFileProvider: TempFileProvider = {
  name: "gofile",
  async upload(filePath: string): Promise<TempFileUploadResult> {
    const result = await uploadToGoFile(filePath);
    return {
      providerName: "gofile",
      pageUrl: result.pageUrl,
      directUrl: result.directUrl,
      fileName: result.fileName,
      fileSize: result.fileSize,
      expireInfo: "deleted after 10 days of inactivity",
    };
  },
};

function buildMultipart(
  boundary: string,
  fileBuffer: Buffer,
  fileName: string,
): Uint8Array {
  const encoder = new TextEncoder();

  const parts: Uint8Array[] = [];

  // File part
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  parts.push(encoder.encode(header));
  parts.push(fileBuffer);

  // Closing boundary
  const closing = `\r\n--${boundary}--\r\n`;
  parts.push(encoder.encode(closing));

  // Concatenate
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}
