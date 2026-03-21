import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface AssetDescriptor {
  cacheControl: string;
  contentType: string;
  filePath: string;
}

const assetRoot = new URL("../../assets/", import.meta.url);
const assetDescriptors = new Map<string, AssetDescriptor>([
  [
    "/assets/console.css",
    {
      cacheControl: "public, max-age=300",
      contentType: "text/css; charset=utf-8",
      filePath: fileURLToPath(new URL("./console.css", assetRoot)),
    },
  ],
  [
    "/assets/fonts/inter-variable.woff2",
    {
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "font/woff2",
      filePath: fileURLToPath(new URL("./fonts/inter-variable.woff2", assetRoot)),
    },
  ],
  [
    "/assets/fonts/manrope-variable.woff2",
    {
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "font/woff2",
      filePath: fileURLToPath(new URL("./fonts/manrope-variable.woff2", assetRoot)),
    },
  ],
]);

function writeAssetNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end("Not found.");
}

export async function handleAssetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/assets/")) {
    return false;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end("Method not allowed.");
    return true;
  }

  const asset = assetDescriptors.get(pathname);

  if (asset === undefined) {
    writeAssetNotFound(response);
    return true;
  }

  const body = request.method === "HEAD" ? undefined : await readFile(asset.filePath);

  response.writeHead(200, {
    "cache-control": asset.cacheControl,
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
  return true;
}
