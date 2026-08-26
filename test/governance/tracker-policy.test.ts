import { describe, expect, it } from "vitest";

import {
  deriveTrackerPolicyRuntime,
  parseAcceptedGovernanceManifest,
  parseTrackerPolicy,
  trackerLane,
} from "../../src/governance/tracker-policy.js";
import { acceptedGovernanceFixture } from "../support/factories.js";

function policyDocument(): Record<string, unknown> {
  const snapshot = acceptedGovernanceFixture().trackerPolicy;
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== "source"),
  );
}

describe("accepted governance contracts", () => {
  it("strictly parses one policy and derives the Symphony runtime projection", () => {
    const governance = acceptedGovernanceFixture();
    const policy = parseTrackerPolicy(
      Buffer.from(JSON.stringify(policyDocument())),
      governance.trackerPolicy.source,
    );

    expect(deriveTrackerPolicyRuntime(policy)).toEqual({
      requiredLabels: ["driver:symphony"],
      excludedLabels: ["driver:direct"],
      activeStates: ["Todo", "In Progress", "Merging", "Rework"],
      terminalStates: ["Done", "Cancelled"],
      freshAttemptStates: ["Rework"],
      freshAttemptFailureState: "Human Review",
    });
    expect(trackerLane(policy, " human review ")?.delivery.materialize).toBe(
      true,
    );
  });

  it("rejects unknown policy keys and unsafe merge authority", () => {
    const governance = acceptedGovernanceFixture();
    const unknown = { ...policyDocument(), candidateOverride: true };
    expect(() =>
      parseTrackerPolicy(
        Buffer.from(JSON.stringify(unknown)),
        governance.trackerPolicy.source,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "tracker_policy_invalid",
        message: expect.stringContaining("unknown key 'candidateOverride'"),
      }),
    );

    const unsafe = policyDocument();
    const lanes = structuredClone(unsafe["lanes"]) as Array<
      Record<string, unknown>
    >;
    const merging = lanes.find((lane) => lane["name"] === "Merging")!;
    merging["writers"] = ["agent", "human"];
    unsafe["lanes"] = lanes;
    expect(() =>
      parseTrackerPolicy(
        Buffer.from(JSON.stringify(unsafe)),
        governance.trackerPolicy.source,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "tracker_policy_invalid",
        message: expect.stringContaining("human-selected"),
      }),
    );
  });

  it("strictly parses the publication manifest", () => {
    const governance = acceptedGovernanceFixture();
    const manifest = {
      schemaVersion: 1,
      repositoryIdentity: governance.doctrine.repositoryIdentity,
      acceptedRevision: governance.doctrine.revision,
      artifacts: {
        doctrine: {
          path: governance.doctrine.path,
          digest: governance.doctrine.digest,
        },
        trackerPolicy: {
          path: governance.trackerPolicy.source.path,
          digest: governance.trackerPolicy.source.digest,
        },
      },
    };
    expect(
      parseAcceptedGovernanceManifest(Buffer.from(JSON.stringify(manifest))),
    ).toEqual(manifest);

    expect(() =>
      parseAcceptedGovernanceManifest(
        Buffer.from(JSON.stringify({ ...manifest, localPath: "/tmp/.github" })),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "governance_manifest_invalid" }),
    );
  });
});
