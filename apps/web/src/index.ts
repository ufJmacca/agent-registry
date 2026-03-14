import { hasAnyRole } from "@agent-registry/auth";
import type { ServiceManifest } from "@agent-registry/contracts";

export const webService: ServiceManifest = {
  name: "web",
  port: 3000,
  summary: `Server-rendered admin and publisher console with mock sign-in. Admin sample access: ${hasAnyRole(["tenant-admin"], ["tenant-admin"])}`,
};
