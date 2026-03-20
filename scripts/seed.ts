import { seedDemoRegistryFromCli } from "../apps/api/src/seed/index.ts";

await seedDemoRegistryFromCli(process.env);
