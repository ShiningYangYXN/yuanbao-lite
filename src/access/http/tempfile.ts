/**
 * Multi-provider temporary file sharing module.
 *
 * Provides upload capabilities for multiple free temporary file hosting services:
 * - tmpfiles.org  (default — fast, configurable)
 * - uguu.se       (simple, random filename)
 * - litterbox.catbox.moe (time-limited, no account)
 * - gofile.io     (via existing gofile.ts module)
 *
 * All providers use Node.js native fetch with manually-built multipart form data.
 */

import { createLog } from "../../logger.js";
import { uploadToGoFile } from "./gofile.js";
import { getNodeModules } from "../persistence/adapter.js";

// ─── Web Crypto + path helpers (browser-safe) ───

/**
 * Generate cryptographically random hex of the given byte length.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get the basename of a path. Uses `node:path.basename` under Node,
 * falls back to pure-JS under browser.
 */
function basename(filePath: string): string {
  const path = getNodeModules().path;
  if (path) return path.basename(filePath);
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return filePath.slice(lastSlash + 1);
}

// ─── Types ───

export type TempFileUploadResult = {
  /** Name of the provider that handled the upload */
  providerName: string;
  /** The file's page URL (view / download page on the provider site) */
  pageUrl: string;
  /** Direct download URL (if available; empty string otherwise) */
  directUrl: string;
  /** Original file name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** Expiration information (e.g. "1h", "24h", "expires after 72h") */
  expireInfo?: string;
};

export type TempFileProvider = {
  /** Human-readable provider name */
  name: string;
  /** Upload a file and return the result */
  upload(filePath: string): Promise<TempFileUploadResult>;
};

// ─── Helpers ───

/**
 * Build a multipart/form-data body from a set of text fields and one file field.
 *
 * @param boundary  - MIME boundary string (must be unique per request)
 * @param fields    - Key/value text fields to include before the file
 * @param fileFieldName - The form field name for the file part
 * @param fileBuffer - The raw file bytes
 * @param fileName  - The filename to declare in the Content-Disposition header
 */
function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  fileFieldName: string,
  fileBuffer: Buffer,
  fileName: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // Text fields
  for (const [key, value] of Object.entries(fields)) {
    const part = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    parts.push(encoder.encode(part));
  }

  // File part
  const header =
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  parts.push(encoder.encode(header));
  parts.push(fileBuffer);

  // Closing boundary
  const closing = `\r\n--${boundary}--\r\n`;
  parts.push(encoder.encode(closing));

  // Concatenate all parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Validate that a file exists and return its stats.
 *
 * Node-only — uses `node:fs.existsSync` and `statSync`. Under browser,
 * throws a clear error (callers should provide file content directly).
 */
function validateFile(filePath: string): { fileName: string; fileSize: number; fileBuffer: Buffer } {
  const { fs } = getNodeModules();
  if (!fs) {
    throw new Error(
      "validateFile requires Node.js runtime (node:fs) to stat local files.",
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStat = fs.statSync(filePath);
  const fileName = basename(filePath);

  return { fileName, fileSize: fileStat.size, fileBuffer: undefined as unknown as Buffer };
}

/**
 * Load file buffer on demand (separated from validateFile to avoid unnecessary reads).
 *
 * Node-only — uses `node:fs.promises.readFile`.
 */
async function loadFile(filePath: string): Promise<Buffer> {
  const { fs } = getNodeModules();
  if (!fs) {
    throw new Error(
      "loadFile requires Node.js runtime (node:fs) to read local files.",
    );
  }
  return fs.promises.readFile(filePath);
}

/**
 * Format a byte count as a human-readable size string.
 */
function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / 1024).toFixed(0)}KB`;
}

// ─── Provider: tmpfiles.org ───

/**
 * Upload a file to tmpfiles.org.
 *
 * API: POST https://tmpfiles.org/api/v1/upload
 * Form field: "file"
 * Response: JSON with data.url (page URL); direct URL is obtained by replacing
 *           the path segment: `/dl/` insertion after the domain.
 */
export async function uploadToTmpfiles(filePath: string): Promise<TempFileUploadResult> {
  const log = createLog("tmpfiles");

  const { fileName, fileSize } = validateFile(filePath);
  const sizeMB = fileSize / (1024 * 1024);

  if (sizeMB > 100) {
    throw new Error(`File too large: ${sizeMB.toFixed(1)}MB exceeds tmpfiles.org limit of ~100MB`);
  }

  log.info(`uploading: ${fileName} (${formatSize(fileSize)})`);

  const fileBuffer = await loadFile(filePath);
  const boundary = `----TmpfilesBoundary${randomHex(8)}`;
  const formData = buildMultipart(boundary, {}, "file", fileBuffer, fileName);

  const resp = await fetch("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.from(formData),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`tmpfiles.org upload failed: HTTP ${resp.status} — ${body}`);
  }

  const data = (await resp.json()) as {
    status: string;
    data?: {
      url?: string;
      name?: string;
      size?: number;
    };
  };

  if (data.status !== "success" || !data.data?.url) {
    throw new Error(`tmpfiles.org upload failed: ${JSON.stringify(data)}`);
  }

  // Convert page URL to direct download URL:
  // Page:    https://tmpfiles.org/12345/filename.ext
  // Direct:  https://tmpfiles.org/dl/12345/filename.ext
  const pageUrl = data.data.url;
  const directUrl = pageUrl.replace(
    /https:\/\/tmpfiles\.org\/(\d+\/.+)$/,
    "https://tmpfiles.org/dl/$1",
  );

  log.info(`upload success: ${pageUrl}`);

  return {
    providerName: "tmpfiles",
    pageUrl,
    directUrl,
    fileName: data.data.name || fileName,
    fileSize: data.data.size || fileSize,
    expireInfo: "auto-deleted after ~1 hour",
  };
}

// ─── Provider: uguu.se ───

/**
 * Upload a file to uguu.se.
 *
 * API: POST https://uguu.se/upload.php
 * Form field: "files[]"
 * Response: JSON with files[0].url and files[0].name
 */
export async function uploadToUguu(filePath: string): Promise<TempFileUploadResult> {
  const log = createLog("uguu");

  const { fileName, fileSize } = validateFile(filePath);
  const sizeMB = fileSize / (1024 * 1024);

  if (sizeMB > 128) {
    throw new Error(`File too large: ${sizeMB.toFixed(1)}MB exceeds uguu.se limit of ~128MB`);
  }

  log.info(`uploading: ${fileName} (${formatSize(fileSize)})`);

  const fileBuffer = await loadFile(filePath);
  const boundary = `----UguuBoundary${randomHex(8)}`;
  const formData = buildMultipart(boundary, {}, "files[]", fileBuffer, fileName);

  const resp = await fetch("https://uguu.se/upload.php", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.from(formData),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`uguu.se upload failed: HTTP ${resp.status} — ${body}`);
  }

  const data = (await resp.json()) as {
    success: boolean;
    files?: Array<{
      url?: string;
      name?: string;
      size?: number;
      hash?: string;
    }>;
    error?: string;
  };

  if (!data.success || !data.files?.[0]?.url) {
    throw new Error(`uguu.se upload failed: ${data.error || JSON.stringify(data)}`);
  }

  const file = data.files[0];
  const pageUrl = file.url!;

  // uguu.se direct URL is the same as page URL (it serves the file directly)
  const directUrl = pageUrl;

  log.info(`upload success: ${pageUrl}`);

  return {
    providerName: "uguu",
    pageUrl,
    directUrl,
    fileName: file.name || fileName,
    fileSize: file.size || fileSize,
    expireInfo: "auto-deleted after ~24 hours",
  };
}

// ─── Provider: litterbox.catbox.moe ───

/**
 * Upload a file to litterbox.catbox.moe (time-limited variant of catbox.moe).
 *
 * API: POST https://litterbox.catbox.moe/resources/internals/api.php
 * Form fields: reqtype=fileupload, time=<1h|12h|24h|72h>, fileToUpload=<file>
 * Response: plain text URL on success, error message on failure
 *
 * @param filePath - Local file path to upload
 * @param expire   - Expiration duration (default "1h")
 */
export async function uploadToLitterbox(
  filePath: string,
  expire: "1h" | "12h" | "24h" | "72h" = "1h",
): Promise<TempFileUploadResult> {
  const log = createLog("litterbox");

  const { fileName, fileSize } = validateFile(filePath);
  const sizeMB = fileSize / (1024 * 1024);

  if (sizeMB > 100) {
    throw new Error(`File too large: ${sizeMB.toFixed(1)}MB exceeds litterbox limit of ~100MB`);
  }

  log.info(`uploading: ${fileName} (${formatSize(fileSize)}), expires in ${expire}`);

  const fileBuffer = await loadFile(filePath);
  const boundary = `----LitterboxBoundary${randomHex(8)}`;
  const formData = buildMultipart(
    boundary,
    { reqtype: "fileupload", time: expire },
    "fileToUpload",
    fileBuffer,
    fileName,
  );

  const resp = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.from(formData),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`litterbox upload failed: HTTP ${resp.status} — ${body}`);
  }

  const text = (await resp.text()).trim();

  // litterbox returns plain text URL on success, or an error message
  if (!text.startsWith("https://")) {
    throw new Error(`litterbox upload failed: ${text}`);
  }

  const pageUrl = text;
  // litterbox direct URL is the same as the page URL
  const directUrl = pageUrl;

  log.info(`upload success: ${pageUrl}`);

  return {
    providerName: "litterbox",
    pageUrl,
    directUrl,
    fileName,
    fileSize,
    expireInfo: `expires after ${expire}`,
  };
}

// ─── GoFile wrapper (adapts existing module to TempFileUploadResult) ───

async function uploadViaGoFile(filePath: string): Promise<TempFileUploadResult> {
  const result = await uploadToGoFile(filePath);
  return {
    providerName: "gofile",
    pageUrl: result.pageUrl,
    directUrl: result.directUrl,
    fileName: result.fileName,
    fileSize: result.fileSize,
    // GoFile free tier: files deleted after inactivity (no strict expiry)
    expireInfo: "deleted after 10 days of inactivity",
  };
}

// ─── Provider registry ───

const PROVIDERS: TempFileProvider[] = [
  {
    name: "tmpfiles",
    upload: uploadToTmpfiles,
  },
  {
    name: "uguu",
    upload: uploadToUguu,
  },
  {
    name: "litterbox",
    upload: (filePath: string) => uploadToLitterbox(filePath, "1h"),
  },
  {
    name: "gofile",
    upload: uploadViaGoFile,
  },
];

const DEFAULT_PROVIDER = "gofile";

// ─── Main upload function ───

/**
 * Upload a file using the specified provider (or the default).
 *
 * @param filePath - Local file path to upload
 * @param provider - Provider name: "tmpfiles" | "uguu" | "litterbox" | "gofile"
 * @returns Upload result with URLs and metadata
 */
export async function uploadToTempFile(
  filePath: string,
  provider?: string,
): Promise<TempFileUploadResult> {
  const log = createLog("tempfile");
  const providerName = provider || DEFAULT_PROVIDER;

  const p = PROVIDERS.find(p => p.name === providerName);
  if (!p) {
    const available = PROVIDERS.map(p => p.name).join(", ");
    throw new Error(
      `Unknown temp file provider "${providerName}". Available: ${available}`,
    );
  }

  log.info(`uploading via ${providerName}: ${basename(filePath)}`);

  try {
    return await p.upload(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${providerName} upload failed: ${message}`);

    // Fallback: try the next provider if the chosen one fails
    const fallbackOrder = PROVIDERS.filter(fb => fb.name !== providerName);
    for (const fallback of fallbackOrder) {
      log.info(`trying fallback provider: ${fallback.name}`);
      try {
        const result = await fallback.upload(filePath);
        log.info(`fallback to ${fallback.name} succeeded`);
        return result;
      } catch {
        // Continue to next fallback
      }
    }

    throw new Error(`All temp file providers failed. Last error: ${message}`, { cause: err });
  }
}

// ─── Format link ───

/**
 * Upload a file and return a formatted share link message.
 *
 * @param filePath    - Local file path to upload
 * @param description - Optional description to include in the message
 * @param provider    - Provider name (defaults to "tmpfiles")
 * @returns Formatted link message string
 */
export async function uploadAndFormatLink(
  filePath: string,
  description?: string,
  provider?: string,
): Promise<string> {
  const result = await uploadToTempFile(filePath, provider);

  const desc = description ? ` (${description})` : "";
  const sizeStr = formatSize(result.fileSize);
  const expireStr = result.expireInfo ? ` [${result.expireInfo}]` : "";

  const link = result.directUrl || result.pageUrl;

  return `文件分享${desc}: ${result.fileName} [${sizeStr}]${expireStr}\n链接: ${link}`;
}
