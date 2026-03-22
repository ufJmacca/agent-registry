import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

import { renderIconSpriteSheet } from "./icons.js";

const assetRoot = new URL("../../assets/", import.meta.url);

export const sharedAssetPaths = {
  icons: "/assets/icons.svg",
  interFont: "/assets/fonts/inter-latin-variable.woff2",
  manropeFont: "/assets/fonts/manrope-latin-variable.woff2",
  stylesheet: "/assets/console.css",
} as const;

interface StaticAsset {
  body: Buffer;
  cacheControl: string;
  contentType: string;
  etag: string;
}

function createStaticAsset(
  body: Buffer | string,
  contentType: string,
  cacheControl: string,
): StaticAsset {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");

  return {
    body: bytes,
    cacheControl,
    contentType,
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
  };
}

function createFileAsset(
  relativePath: string,
  contentType: string,
  cacheControl: string,
): StaticAsset {
  return createStaticAsset(
    readFileSync(new URL(relativePath, assetRoot)),
    contentType,
    cacheControl,
  );
}

const assets = new Map<string, StaticAsset>([
  [
    "console.css",
    createFileAsset("console.css", "text/css; charset=utf-8", "public, max-age=300"),
  ],
  [
    "fonts/inter-latin-variable.woff2",
    createFileAsset(
      "fonts/inter-latin-variable.woff2",
      "font/woff2",
      "public, max-age=31536000, immutable",
    ),
  ],
  [
    "fonts/manrope-latin-variable.woff2",
    createFileAsset(
      "fonts/manrope-latin-variable.woff2",
      "font/woff2",
      "public, max-age=31536000, immutable",
    ),
  ],
  [
    "icons.svg",
    createStaticAsset(
      renderIconSpriteSheet(),
      "image/svg+xml; charset=utf-8",
      "public, max-age=300",
    ),
  ],
]);

export function resolveStaticAsset(pathname: string): StaticAsset | null {
  if (!pathname.startsWith("/assets/")) {
    return null;
  }

  const relativePath = pathname.slice("/assets/".length);

  if (
    relativePath === "" ||
    relativePath.startsWith("/") ||
    relativePath.includes("..") ||
    relativePath.includes("\\")
  ) {
    return null;
  }

  return assets.get(relativePath) ?? null;
}

export function writeStaticAsset(
  response: ServerResponse,
  requestMethod: string | undefined,
  asset: StaticAsset,
): void {
  response.writeHead(200, {
    "cache-control": asset.cacheControl,
    "content-length": String(asset.body.byteLength),
    "content-type": asset.contentType,
    etag: asset.etag,
    "x-content-type-options": "nosniff",
  });

  if (requestMethod === "HEAD") {
    response.end();
    return;
  }

  response.end(asset.body);
}
