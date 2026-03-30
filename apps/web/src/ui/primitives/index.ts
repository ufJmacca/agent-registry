import {
  formatConsoleState as formatConsoleStateImplementation,
  formatConsoleTimestamp as formatConsoleTimestampImplementation,
} from "./formatters.js";
import {
  renderFormField as renderFormFieldImplementation,
  renderFormSection as renderFormSectionImplementation,
} from "./forms.js";
import {
  renderActionCluster as renderActionClusterImplementation,
  renderCardHead as renderCardHeadImplementation,
  renderEmptyState as renderEmptyStateImplementation,
  renderPill as renderPillImplementation,
  renderPillList as renderPillListImplementation,
  renderRecordList as renderRecordListImplementation,
  renderSectionFrame as renderSectionFrameImplementation,
  renderSidePanel as renderSidePanelImplementation,
  renderStatTile as renderStatTileImplementation,
} from "./renderers.js";

type PrimitiveFunction = (...args: any[]) => any;

interface PrimitiveOverrideMap {
  formatConsoleState: typeof formatConsoleStateImplementation;
  formatConsoleTimestamp: typeof formatConsoleTimestampImplementation;
  renderActionCluster: typeof renderActionClusterImplementation;
  renderCardHead: typeof renderCardHeadImplementation;
  renderEmptyState: typeof renderEmptyStateImplementation;
  renderFormField: typeof renderFormFieldImplementation;
  renderFormSection: typeof renderFormSectionImplementation;
  renderPill: typeof renderPillImplementation;
  renderPillList: typeof renderPillListImplementation;
  renderRecordList: typeof renderRecordListImplementation;
  renderSectionFrame: typeof renderSectionFrameImplementation;
  renderSidePanel: typeof renderSidePanelImplementation;
  renderStatTile: typeof renderStatTileImplementation;
}

type PrimitiveTestOverrides = Partial<PrimitiveOverrideMap>;

let primitiveTestOverrides: PrimitiveTestOverrides = {};

function callPrimitive<F extends PrimitiveFunction>(
  key: keyof PrimitiveOverrideMap,
  implementation: F,
  ...args: Parameters<F>
): ReturnType<F> {
  const override = primitiveTestOverrides[key] as F | undefined;

  return (override ?? implementation)(...args);
}

// Test-only seam for delegation-sensitive page assertions.
export function installPrimitiveTestOverrides(overrides: PrimitiveTestOverrides): void {
  primitiveTestOverrides = {
    ...primitiveTestOverrides,
    ...overrides,
  };
}

export function resetPrimitiveTestOverrides(): void {
  primitiveTestOverrides = {};
}

export function formatConsoleState(...args: Parameters<typeof formatConsoleStateImplementation>) {
  return callPrimitive("formatConsoleState", formatConsoleStateImplementation, ...args);
}

export function formatConsoleTimestamp(
  ...args: Parameters<typeof formatConsoleTimestampImplementation>
) {
  return callPrimitive("formatConsoleTimestamp", formatConsoleTimestampImplementation, ...args);
}

export function renderFormField(...args: Parameters<typeof renderFormFieldImplementation>) {
  return callPrimitive("renderFormField", renderFormFieldImplementation, ...args);
}

export function renderFormSection(...args: Parameters<typeof renderFormSectionImplementation>) {
  return callPrimitive("renderFormSection", renderFormSectionImplementation, ...args);
}

export function renderActionCluster(
  ...args: Parameters<typeof renderActionClusterImplementation>
) {
  return callPrimitive("renderActionCluster", renderActionClusterImplementation, ...args);
}

export function renderCardHead(...args: Parameters<typeof renderCardHeadImplementation>) {
  return callPrimitive("renderCardHead", renderCardHeadImplementation, ...args);
}

export function renderEmptyState(...args: Parameters<typeof renderEmptyStateImplementation>) {
  return callPrimitive("renderEmptyState", renderEmptyStateImplementation, ...args);
}

export function renderPill(...args: Parameters<typeof renderPillImplementation>) {
  return callPrimitive("renderPill", renderPillImplementation, ...args);
}

export function renderPillList(...args: Parameters<typeof renderPillListImplementation>) {
  return callPrimitive("renderPillList", renderPillListImplementation, ...args);
}

export function renderRecordList(...args: Parameters<typeof renderRecordListImplementation>) {
  return callPrimitive("renderRecordList", renderRecordListImplementation, ...args);
}

export function renderSectionFrame(
  ...args: Parameters<typeof renderSectionFrameImplementation>
) {
  return callPrimitive("renderSectionFrame", renderSectionFrameImplementation, ...args);
}

export function renderSidePanel(...args: Parameters<typeof renderSidePanelImplementation>) {
  return callPrimitive("renderSidePanel", renderSidePanelImplementation, ...args);
}

export function renderStatTile(...args: Parameters<typeof renderStatTileImplementation>) {
  return callPrimitive("renderStatTile", renderStatTileImplementation, ...args);
}
