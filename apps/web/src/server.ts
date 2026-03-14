import http from "node:http";

import { createWebRequestListener } from "./http.js";
import { webService } from "./index.js";
import { initializeWebRuntime } from "./main.js";

const runtime = await initializeWebRuntime();
const server = http.createServer(
  createWebRequestListener({
    config: runtime.config,
    db: runtime.db,
  }),
);

server.listen(webService.port, () => {
  console.log(`web console listening on http://0.0.0.0:${webService.port}`);
});
