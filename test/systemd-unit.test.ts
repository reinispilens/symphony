import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const unit = readFileSync(
  new URL("../deploy/systemd/user/symphony@.service", import.meta.url),
  "utf8",
);

function section(name: string): string {
  const marker = `[${name}]\n`;
  const start = unit.indexOf(marker);
  if (start === -1) throw new Error(`missing systemd section ${name}`);
  const bodyStart = start + marker.length;
  const next = unit.indexOf("\n[", bodyStart);
  return unit.slice(bodyStart, next === -1 ? unit.length : next);
}

describe("per-user systemd service", () => {
  it("loads one required instance environment and launches explicit immutable paths", () => {
    const service = section("Service");

    expect(service).toContain("EnvironmentFile=%h/.config/symphony/%i.env");
    expect(service).toContain(
      "ExecStart=/usr/bin/env ${SYMPHONY_NODE_PATH} ${SYMPHONY_CLI_PATH} --binding ${SYMPHONY_BINDING_PATH}",
    );
    expect(service).not.toMatch(/^EnvironmentFile=-/mu);
    expect(service).not.toMatch(/^(?:User|Group)=/mu);
  });

  it("keeps the daemon supervised and preserves graceful process-group shutdown", () => {
    const service = section("Service");
    const install = section("Install");

    expect(service).toContain("Type=simple");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("RestartSec=5s");
    expect(service).toContain("TimeoutStopSec=90s");
    expect(service).toContain("KillMode=control-group");
    expect(service).toContain("UMask=0077");
    expect(install).toContain("WantedBy=default.target");
  });
});
