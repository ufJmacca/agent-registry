import assert from "node:assert/strict";
import test from "node:test";

import {
  getMissingRequiredContextKeys,
  getUnresolvedRequiredHeaderSources,
} from "../apps/api/src/modules/preflight/service.ts";

test("getUnresolvedRequiredHeaderSources resolves required sources from flat and nested user context", () => {
  // Arrange
  const headerContract = [
    {
      description: "Identifies the end user.",
      name: "X-User-Id",
      required: true,
      source: "user.id",
    },
    {
      description: "Routes requests by department.",
      name: "X-Department",
      required: true,
      source: "user.department",
    },
    {
      description: "Carries an optional region hint.",
      name: "X-Region",
      required: true,
      source: "user.profile.region",
    },
    {
      description: "Adds email when it is available.",
      name: "X-User-Email",
      required: false,
      source: "user.email",
    },
  ];
  const userContext = {
    department: "support",
    id: "caller-123",
    user: {
      profile: {
        region: "us-east-1",
      },
    },
  };

  // Act
  const unresolvedSources = getUnresolvedRequiredHeaderSources(userContext, headerContract);

  // Assert
  assert.deepEqual(unresolvedSources, []);
});

test("getMissingRequiredContextKeys reports only required missing keys and keeps falsy values as ready", () => {
  // Arrange
  const contextContract = [
    {
      description: "Selects the client partition.",
      key: "client_id",
      required: true,
      type: "string" as const,
    },
    {
      description: "Turns dry-run mode on or off.",
      key: "dry_run",
      required: true,
      type: "boolean" as const,
    },
    {
      description: "Controls retry count.",
      key: "retry_count",
      required: true,
      type: "number" as const,
    },
    {
      description: "Provides an optional locale override.",
      key: "locale",
      required: false,
      type: "string" as const,
    },
  ];
  const contextValues = {
    client_id: "",
    dry_run: false,
    retry_count: 0,
  };

  // Act
  const missingKeys = getMissingRequiredContextKeys(contextValues, contextContract);

  // Assert
  assert.deepEqual(missingKeys, []);
});
