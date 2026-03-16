export const supportedEnvironments = ["dev", "test", "staging", "prod"] as const;

export type EnvironmentKey = (typeof supportedEnvironments)[number];

export interface ServiceManifest {
  name: string;
  port: number;
  summary: string;
}

export interface WorkspaceModule {
  description: string;
  kind: "app" | "package";
  name: string;
}
