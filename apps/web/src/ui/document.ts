import { sharedAssetPaths } from "./assets.js";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPreformattedJson(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

export function renderDocument(options: {
  body: string;
  lang?: string;
  title: string;
}): string {
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(options.title)}</title>
    <link
      rel="preload"
      href="${sharedAssetPaths.manropeFont}"
      as="font"
      type="font/woff2"
      crossorigin
    />
    <link
      rel="preload"
      href="${sharedAssetPaths.interFont}"
      as="font"
      type="font/woff2"
      crossorigin
    />
    <link rel="stylesheet" href="${sharedAssetPaths.stylesheet}" />
  </head>
  <body>
    <main>${options.body}</main>
  </body>
</html>`;
}
