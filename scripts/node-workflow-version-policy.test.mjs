import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedWorkflowNodeVersion } from "./node-workflow-version-policy.mjs";

test("accepts the supported major and reproducible supported patch pins", () => {
  for (const version of ["24", "24.11.0", "24.20.0"]) {
    assert.equal(isSupportedWorkflowNodeVersion(version), true, version);
  }
});

test("rejects unsupported majors, old versions and non-exact pins", () => {
  for (const version of ["22", "25", "24.10.9", "24.11", "24.x", "24.11.0-rc.1", "24.011.0", ">=24.11.0"]) {
    assert.equal(isSupportedWorkflowNodeVersion(version), false, version);
  }
});
