import { createServiceRuntimeConfig } from "@agent-registry/config";
import type { ServiceManifest } from "@agent-registry/contracts";

export { createApiRequestListener } from "./http.js";
export { initializeApiRuntime } from "./main.js";

const apiManifest: ServiceManifest = {
  name: "api",
  port: 4000,
  summary: "REST API placeholder for the agent registry.",
};

export const apiService = createServiceRuntimeConfig(apiManifest, "dev");
