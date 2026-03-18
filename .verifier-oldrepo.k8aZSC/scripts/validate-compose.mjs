import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parse } from "yaml";

const rootDir = process.cwd();
const composePath = path.join(rootDir, "compose.yaml");
const composeDocument = parse(fs.readFileSync(composePath, "utf8"));

const requiredServices = ["workspace", "postgres", "api", "worker", "web"];
const services = composeDocument?.services ?? {};
const workspaceBuild =
  services.workspace?.build ??
  services.workspace?.["<<"]?.build ??
  composeDocument?.["x-workspace-service"]?.build;

for (const serviceName of requiredServices) {
  if (!services[serviceName]) {
    throw new Error(`compose service '${serviceName}' is missing`);
  }
}

if (services.postgres.image !== "postgres:16-alpine") {
  throw new Error("postgres must use the postgres:16-alpine image");
}

if (workspaceBuild?.dockerfile !== "Dockerfile.workspace") {
  throw new Error("workspace must build from Dockerfile.workspace");
}

console.log("compose.yaml is structurally valid for the workspace scaffold");
