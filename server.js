const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"]
]);

let backendWorker;
let currentJobId = 0;
let currentFolderPath = "";
let currentDocuments = [];

const eventClients = new Set();

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (requestUrl.pathname === "/api/status" && request.method === "GET") {
      sendJson(response, {
        ok: true,
        folderPath: currentFolderPath,
        documentCount: currentDocuments.length
      });
      return;
    }

    if (requestUrl.pathname === "/api/events" && request.method === "GET") {
      openEventStream(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/folders" && request.method === "GET") {
      await handleFolderList(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/scan" && request.method === "POST") {
      await handleScan(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/search" && request.method === "POST") {
      await handleSearch(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/cancel" && request.method === "POST") {
      getBackendWorker().postMessage({ type: "cancel" });
      sendJson(response, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/api/file" && request.method === "GET") {
      await handleFile(requestUrl, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(requestUrl.pathname, request.method, response);
      return;
    }

    sendJson(response, { error: "Not found." }, 404);
  } catch (error) {
    sendJson(response, { error: error.message || "Request failed." }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Document Keyword Search web app running at http://${HOST}:${PORT}`);
});

function getBackendWorker() {
  if (backendWorker) {
    return backendWorker;
  }

  backendWorker = new Worker(path.join(ROOT_DIR, "search-backend-worker.js"), {
    workerData: {
      cacheFile: path.join(os.homedir(), ".document-keyword-search", "search-cache.json")
    }
  });

  backendWorker.on("message", (message) => {
    if (message?.type === "scan:done") {
      currentFolderPath = message.folderPath || "";
      currentDocuments = Array.isArray(message.documents) ? message.documents : [];
    }

    broadcastEvent(message);
  });

  backendWorker.on("error", (error) => {
    broadcastEvent({
      type: "error",
      message: error.message || "Worker failed."
    });
  });

  backendWorker.on("exit", () => {
    backendWorker = null;
  });

  return backendWorker;
}

async function handleFolderList(requestUrl, response) {
  const requestedPath = requestUrl.searchParams.get("path") || "";

  if (!requestedPath) {
    sendJson(response, {
      currentPath: "",
      parentPath: "",
      roots: await getFolderRoots(),
      folders: []
    });
    return;
  }

  const folderPath = path.resolve(requestedPath);
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  const folders = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    folders.push({
      name: entry.name,
      path: path.join(folderPath, entry.name)
    });
  }

  folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  sendJson(response, {
    currentPath: folderPath,
    parentPath: getParentPath(folderPath),
    roots: await getFolderRoots(),
    folders
  });
}

async function handleScan(request, response) {
  const body = await readJsonBody(request);
  const folderPath = path.resolve(String(body.folderPath || ""));

  await assertDirectory(folderPath);

  const jobId = ++currentJobId;
  currentFolderPath = folderPath;
  currentDocuments = [];

  getBackendWorker().postMessage({
    type: "scan",
    jobId,
    folderPath
  });

  sendJson(response, {
    ok: true,
    jobId
  });
}

async function handleSearch(request, response) {
  const body = await readJsonBody(request);
  const folderPath = path.resolve(String(body.folderPath || currentFolderPath || ""));
  const keyword = String(body.keyword || "").trim();

  await assertDirectory(folderPath);

  if (!keyword) {
    sendJson(response, { error: "Enter a keyword to search." }, 400);
    return;
  }

  const jobId = ++currentJobId;

  getBackendWorker().postMessage({
    type: "search",
    jobId,
    payload: {
      folderPath,
      keyword,
      extensions: Array.isArray(body.extensions) ? body.extensions : [],
      options: {
        caseSensitive: Boolean(body.options?.caseSensitive),
        includeFileNames: body.options?.includeFileNames !== false
      }
    }
  });

  sendJson(response, {
    ok: true,
    jobId
  });
}

async function handleFile(requestUrl, response) {
  const filePath = path.resolve(requestUrl.searchParams.get("path") || "");

  if (!isKnownDocumentPath(filePath)) {
    sendJson(response, { error: "File is not part of the current scan." }, 403);
    return;
  }

  const stats = await fsp.stat(filePath);

  if (!stats.isFile()) {
    sendJson(response, { error: "File not found." }, 404);
    return;
  }

  response.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Content-Length": stats.size,
    "Content-Disposition": `inline; filename="${path.basename(filePath).replace(/"/g, "")}"`
  });

  fs.createReadStream(filePath).pipe(response);
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  response.write("retry: 1000\n\n");
  response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  eventClients.add(response);

  request.on("close", () => {
    eventClients.delete(response);
  });
}

function broadcastEvent(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;

  for (const client of eventClients) {
    client.write(payload);
  }
}

async function serveStatic(urlPath, method, response) {
  const relativePath = STATIC_FILES.get(urlPath);

  if (!relativePath) {
    sendJson(response, { error: "Not found." }, 404);
    return;
  }

  const filePath = path.join(ROOT_DIR, relativePath);
  const contentType = getContentType(filePath);

  if (method === "HEAD") {
    response.writeHead(200, { "Content-Type": contentType });
    response.end();
    return;
  }

  response.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function assertDirectory(folderPath) {
  const stats = await fsp.stat(folderPath);

  if (!stats.isDirectory()) {
    throw new Error("Folder path must point to a directory.");
  }
}

function isKnownDocumentPath(filePath) {
  return currentDocuments.some((document) => path.resolve(document.path) === filePath);
}

async function getFolderRoots() {
  const roots = [];

  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;

      try {
        await fsp.access(drive);
        roots.push({ name: drive, path: drive });
      } catch {
        continue;
      }
    }
  } else {
    roots.push({ name: "/", path: "/" });
  }

  const homePath = os.homedir();
  const cwdPath = process.cwd();

  if (homePath) {
    roots.push({ name: "Home", path: homePath });
  }

  if (cwdPath && cwdPath !== homePath) {
    roots.push({ name: "App folder", path: cwdPath });
  }

  return roots;
}

function getParentPath(folderPath) {
  const parentPath = path.dirname(folderPath);
  return parentPath === folderPath ? "" : parentPath;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
    case ".csv":
    case ".xml":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}
