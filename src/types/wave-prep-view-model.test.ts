import { describe, expect, it } from "vitest";

import {
  createWavePrepWorkspaceViewModel,
  type ContributorRow,
} from "@/types";

function row(overrides: Partial<ContributorRow> = {}): ContributorRow {
  return {
    id: "reg-1",
    githubUsername: "octocat",
    stellarAddress: "G".concat("A".repeat(55)),
    trustlineReady: true,
    trustlineAuthorized: true,
    verified: true,
    funded: true,
    xlmBalance: "100",
    spendableXlmBalance: "90",
    usdcBalance: "10",
    lastCheckedAt: null,
    horizonLatencyMs: null,
    readiness: "ready",
    ...overrides,
  };
}

describe("createWavePrepWorkspaceViewModel", () => {
  it("builds a view-model from a contributor list (happy path)", () => {
    const model = createWavePrepWorkspaceViewModel([row()], {
      waveNumber: 3,
      isExporting: false,
    });

    expect(model.contributors).toHaveLength(1);
    expect(model.contributors[0].githubUsername).toBe("octocat");
    expect(model.waveNumber).toBe(3);
    expect(model.isExporting).toBe(false);
  });

  it("accepts an empty contributor list", () => {
    const model = createWavePrepWorkspaceViewModel([]);
    expect(model.contributors).toEqual([]);
  });

  it("rejects non-array input with a stable error", () => {
    expect(() => createWavePrepWorkspaceViewModel(null)).toThrow(
      "waveprep: contributors must be an array"
    );
    expect(() => createWavePrepWorkspaceViewModel({})).toThrow(
      "waveprep: contributors must be an array"
    );
  });

  it("rejects malformed rows with a stable error", () => {
    expect(() =>
      createWavePrepWorkspaceViewModel([row(), null])
    ).toThrow("waveprep: contributors must be contributor rows");
  });
});
