import http from "node:http";

import { apiService } from "./index.js";
import { createApiRequestListener } from "./http.js";
import { initializeApiRuntime } from "./main.js";

const runtime = await initializeApiRuntime();
const port = apiService.port;
const server = http.createServer(
  createApiRequestListener({
    config: runtime.config,
    db: runtime.db,
  }),
);

server.listen(port, () => {
  console.log(`api listening on http://0.0.0.0:${port}`);
});
