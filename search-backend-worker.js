const fs = require("node:fs/promises");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const JSZip = require("jszip");
const pdfParse = require("pdf-parse");

const CACHE_VERSION = 1;
const MAX_CONTENT_SEARCH_SIZE = 50 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 180;

const SUPPORTED_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "docm",
  "dotx",
  "xlsx",
  "xlsm",
  "xltx",
  "csv",
  "txt",
  "md",
  "rtf",
  "json",
  "xml",
  "html",
  "htm",
  "pptx",
  "doc",
  "xls"
]);

const ZIP_WORD_EXTENSIONS = new Set(["docx", "docm", "dotx"]);
const ZIP_EXCEL_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx"]);
const ZIP_PRESENTATION_EXTENSIONS = new Set(["pptx"]);
const TEXT_EXTENSIONS = new Set(["csv", "txt", "md", "rtf", "json", "xml", "html", "htm"]);
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls"]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  "appdata",
  "application data",
  "local settings",
  "$recycle.bin",
  "system volume information"
]);

let activeJobId = 0;
let cancelRequested = false;
let currentFolderPath = "";
let currentDocuments = [];
let cacheLoaded = false;
let cacheDirty = false;
let cacheWritesSinceSave = 0;
let textCache = {
  version: CACHE_VERSION,
  entries: {}
};

if (!parentPort) {
  process.exit(1);
}

parentPort.on("message", (message) => {
  if (message?.type === "cancel") {
    cancelRequested = true;
    return;
  }

  if (!message?.jobId) {
    return;
  }

  activeJobId = message.jobId;
  cancelRequested = false;

  if (message.type === "scan") {
    runJob(message.jobId, () => scanFolder(message.jobId, message.folderPath));
    return;
  }

  if (message.type === "search") {
    runJob(message.jobId, () => searchDocuments(message.jobId, message.payload || {}));
  }
});

async function runJob(jobId, job) {
  try {
    await job();
  } catch (error) {
    if (isActive(jobId)) {
      send({
        type: "error",
        jobId,
        message: error instanceof Error ? error.message : "Desktop worker failed."
      });
    }
  }
}

async function scanFolder(jobId, folderPath) {
  const stats = createScanStats();
  const documents = [];
  const normalizedFolderPath = String(folderPath || "");
  let lastProgressAt = 0;

  if (!normalizedFolderPath) {
    send({
      type: "error",
      jobId,
      message: "No folder path was provided."
    });
    return;
  }

  await walkFolder(normalizedFolderPath, documents, stats, jobId, () => {
    const now = Date.now();

    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) {
      return;
    }

    lastProgressAt = now;
    sendScanProgress(jobId, stats);
  });

  if (!isActive(jobId)) {
    send({
      type: "scan:cancelled",
      jobId
    });
    return;
  }

  currentFolderPath = normalizedFolderPath;
  currentDocuments = documents;

  sendScanProgress(jobId, stats);
  send({
    type: "scan:done",
    jobId,
    folderPath: currentFolderPath,
    folderName: path.basename(currentFolderPath) || currentFolderPath,
    documents: currentDocuments.map(toPublicDocument),
    stats
  });
}

async function walkFolder(folderPath, documents, stats, jobId, onProgress) {
  if (!isActive(jobId)) {
    return;
  }

  let directory;

  try {
    directory = await fs.opendir(folderPath);
  } catch {
    stats.unreadableDirectories += 1;
    return;
  }

  for await (const entry of directory) {
    if (!isActive(jobId)) {
      return;
    }

    const fullPath = path.join(folderPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      stats.scannedDirectories += 1;

      if (SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        stats.skippedDirectories += 1;
        continue;
      }

      await walkFolder(fullPath, documents, stats, jobId, onProgress);
      onProgress();
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    stats.scannedFiles += 1;

    const extension = getExtension(entry.name);

    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      onProgress();
      continue;
    }

    try {
      const fileStats = await fs.stat(fullPath);

      documents.push({
        name: entry.name,
        path: fullPath,
        extension,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs
      });

      stats.foundFiles += 1;
    } catch {
      stats.unreadableFiles += 1;
    }

    onProgress();
  }
}

async function searchDocuments(jobId, payload) {
  const keyword = String(payload.keyword || "").trim();
  const options = {
    caseSensitive: Boolean(payload.options?.caseSensitive),
    includeFileNames: payload.options?.includeFileNames !== false
  };

  const selectedExtensions = new Set(
    Array.isArray(payload.extensions) ? payload.extensions.map((extension) => String(extension).toLowerCase()) : []
  );

  if (!keyword) {
    sendSearchDone(jobId, {
      matchedCount: 0,
      searchedCount: 0,
      warningCount: 0,
      errorCount: 0,
      skippedLargeCount: 0
    });
    return;
  }

  if (payload.folderPath && payload.folderPath !== currentFolderPath) {
    currentFolderPath = String(payload.folderPath);
    currentDocuments = [];
    const stats = createScanStats();
    await walkFolder(currentFolderPath, currentDocuments, stats, jobId, () => {});
  }

  const documents = currentDocuments.filter((document) => (
    selectedExtensions.size === 0 || selectedExtensions.has(document.extension)
  ));

  let matchedCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let skippedLargeCount = 0;
  let lastProgressAt = 0;

  send({
    type: "search:started",
    jobId,
    total: documents.length
  });

  for (let index = 0; index < documents.length; index += 1) {
    if (!isActive(jobId)) {
      await saveCache();
      send({
        type: "search:cancelled",
        jobId,
        matchedCount,
        checked: index,
        total: documents.length
      });
      return;
    }

    const document = documents[index];

    try {
      const match = await searchDocument(document, keyword, options);

      if (match?.skippedLarge) {
        skippedLargeCount += 1;
      } else if (match) {
        matchedCount += 1;

        if (match.warning) {
          warningCount += 1;
        }

        send({
          type: "search:result",
          jobId,
          match,
          matchedCount
        });
      }
    } catch {
      errorCount += 1;
    }

    const now = Date.now();

    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || index === documents.length - 1) {
      lastProgressAt = now;
      send({
        type: "search:progress",
        jobId,
        checked: index + 1,
        total: documents.length,
        matchedCount
      });
    }
  }

  await saveCache();

  if (!isActive(jobId)) {
    send({
      type: "search:cancelled",
      jobId,
      matchedCount,
      checked: documents.length,
      total: documents.length
    });
    return;
  }

  sendSearchDone(jobId, {
    matchedCount,
    searchedCount: documents.length,
    warningCount,
    errorCount,
    skippedLargeCount
  });
}

async function searchDocument(document, keyword, options) {
  if (options.includeFileNames) {
    const fileNameIndex = findMatchIndex(document.path, keyword, options.caseSensitive);

    if (fileNameIndex !== -1) {
      return createMatch(document, "File name", createSnippet(document.path, fileNameIndex, keyword.length));
    }
  }

  if (document.size > MAX_CONTENT_SEARCH_SIZE) {
    return {
      skippedLarge: true
    };
  }

  const extracted = await getDocumentText(document);
  const contentIndex = findMatchIndex(extracted.text || "", keyword, options.caseSensitive);

  if (contentIndex === -1) {
    return null;
  }

  return createMatch(
    document,
    "Content",
    createSnippet(extracted.text || "", contentIndex, keyword.length),
    extracted.warning || ""
  );
}

async function getDocumentText(document) {
  await ensureCacheLoaded();

  const cached = textCache.entries[document.path];

  if (
    cached &&
    cached.version === CACHE_VERSION &&
    cached.size === document.size &&
    cached.mtimeMs === document.mtimeMs &&
    cached.extension === document.extension
  ) {
    return cached;
  }

  const extracted = await extractFileText(document);
  const cacheEntry = {
    version: CACHE_VERSION,
    extension: document.extension,
    size: document.size,
    mtimeMs: document.mtimeMs,
    text: extracted.text || "",
    warning: extracted.warning || ""
  };

  textCache.entries[document.path] = cacheEntry;
  cacheDirty = true;
  cacheWritesSinceSave += 1;

  if (cacheWritesSinceSave >= 25) {
    await saveCache();
  }

  return cacheEntry;
}

async function extractFileText(document) {
  if (document.extension === "pdf") {
    const buffer = await fs.readFile(document.path);
    const data = await pdfParse(buffer);
    return {
      text: data.text || ""
    };
  }

  if (ZIP_WORD_EXTENSIONS.has(document.extension)) {
    return extractOfficeZipText(document.path, "word/", extractParagraphXmlText);
  }

  if (ZIP_EXCEL_EXTENSIONS.has(document.extension)) {
    return extractOfficeZipText(document.path, "xl/", extractParagraphXmlText);
  }

  if (ZIP_PRESENTATION_EXTENSIONS.has(document.extension)) {
    return extractOfficeZipText(document.path, "ppt/", extractXmlReadableText);
  }

  if (TEXT_EXTENSIONS.has(document.extension)) {
    return {
      text: await fs.readFile(document.path, "utf8")
    };
  }

  if (LEGACY_OFFICE_EXTENSIONS.has(document.extension)) {
    return {
      text: extractPrintableText(await fs.readFile(document.path)),
      warning: "Legacy .doc and .xls files are searched with best-effort extraction."
    };
  }

  return {
    text: ""
  };
}

async function extractOfficeZipText(filePath, prefix, extractText) {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => (
    name.startsWith(prefix) &&
    name.endsWith(".xml") &&
    !name.includes("/_rels/")
  ));

  const parts = [];

  for (const name of names) {
    const file = zip.file(name);

    if (!file) {
      continue;
    }

    parts.push(extractText(await file.async("text")));
  }

  return {
    text: parts.join("\n")
  };
}

async function ensureCacheLoaded() {
  if (cacheLoaded) {
    return;
  }

  cacheLoaded = true;

  try {
    const raw = await fs.readFile(workerData.cacheFile, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      textCache = parsed;
    }
  } catch {
    textCache = {
      version: CACHE_VERSION,
      entries: {}
    };
  }
}

async function saveCache() {
  if (!cacheDirty) {
    return;
  }

  await fs.mkdir(path.dirname(workerData.cacheFile), {
    recursive: true
  });

  await fs.writeFile(workerData.cacheFile, JSON.stringify(textCache), "utf8");
  cacheDirty = false;
  cacheWritesSinceSave = 0;
}

function sendSearchDone(jobId, payload) {
  send({
    type: "search:done",
    jobId,
    ...payload
  });
}

function sendScanProgress(jobId, stats) {
  send({
    type: "scan:progress",
    jobId,
    scannedFiles: stats.scannedFiles,
    scannedDirectories: stats.scannedDirectories,
    skippedDirectories: stats.skippedDirectories,
    foundFiles: stats.foundFiles
  });
}

function createScanStats() {
  return {
    scannedFiles: 0,
    scannedDirectories: 0,
    skippedDirectories: 0,
    unreadableFiles: 0,
    unreadableDirectories: 0,
    foundFiles: 0
  };
}

function toPublicDocument(document) {
  return {
    name: document.name,
    path: document.path,
    extension: document.extension,
    size: document.size,
    mtimeMs: document.mtimeMs
  };
}

function createMatch(document, source, snippet, warning = "") {
  return {
    name: document.name,
    path: document.path,
    extension: document.extension,
    source,
    snippet,
    warning
  };
}

function extractXmlReadableText(xml) {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, " "));
}

function extractParagraphXmlText(xml) {
  const paragraphMatches = xml.match(/<[^:>]*:?p[\s>][\s\S]*?<\/[^:>]*:?p>/g);

  if (!paragraphMatches) {
    return extractXmlReadableText(xml);
  }

  return paragraphMatches.map((paragraph) => {
    const textNodes = paragraph.match(/<[^:>]*:?(t|instrText)[^>]*>[\s\S]*?<\/[^:>]*:?\1>/g);

    if (!textNodes) {
      return "";
    }

    return textNodes.map(extractXmlReadableText).join("");
  }).join("\n");
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrintableText(buffer) {
  const latinText = new TextDecoder("windows-1252", {
    fatal: false
  }).decode(buffer);

  const utf16Text = new TextDecoder("utf-16le", {
    fatal: false
  }).decode(buffer);

  return `${latinText}\n${utf16Text}`
    .replace(/[^\t\n\r\x20-\x7E\u00A0-\u024F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createSnippet(text, index, length) {
  const safeIndex = Math.min(index, text.length);
  const start = Math.max(0, safeIndex - 90);
  const end = Math.min(text.length, safeIndex + length + 130);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  const normalized = text.slice(start, end).replace(/\s+/g, " ").trim();

  return `${prefix}${normalized}${suffix}`;
}

function findMatchIndex(text, keyword, caseSensitive) {
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLocaleLowerCase();
  return source.indexOf(needle);
}

function getExtension(fileName) {
  const cleanName = fileName.toLowerCase();
  const lastDot = cleanName.lastIndexOf(".");
  return lastDot === -1 ? "" : cleanName.slice(lastDot + 1);
}

function isActive(jobId) {
  return activeJobId === jobId && !cancelRequested;
}

function send(message) {
  parentPort.postMessage(message);
}
