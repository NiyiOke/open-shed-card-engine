import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_ATTESTATION,
  CODEX_ATTESTATION,
  RESPONSIBILITY_ATTESTATION,
  validateAiContributionAttestation,
} from "../scripts/validate-pr-ai-attestation.mjs";

function bodyWith({
  codex = false,
  claude = false,
  responsibility = false,
} = {}) {
  return [
    "## Required AI-agent attestation",
    "",
    `- [${codex ? "x" : " "}] ${CODEX_ATTESTATION}`,
    `- [${claude ? "x" : " "}] ${CLAUDE_ATTESTATION}`,
    "",
    `- [${responsibility ? "x" : " "}] ${RESPONSIBILITY_ATTESTATION}`,
  ].join("\n");
}

test("accepts a Codex attestation", () => {
  const result = validateAiContributionAttestation(
    bodyWith({ codex: true, responsibility: true }),
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.selectedAgents, [CODEX_ATTESTATION]);
});

test("accepts a Claude attestation and uppercase checkbox marker", () => {
  const body = bodyWith({ claude: true, responsibility: true }).replaceAll(
    "[x]",
    "[X]",
  );
  const result = validateAiContributionAttestation(body);

  assert.equal(result.valid, true);
  assert.deepEqual(result.selectedAgents, [CLAUDE_ATTESTATION]);
});

test("accepts disclosure when both permitted agents were used", () => {
  const result = validateAiContributionAttestation(
    bodyWith({ codex: true, claude: true, responsibility: true }),
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.selectedAgents, [
    CODEX_ATTESTATION,
    CLAUDE_ATTESTATION,
  ]);
});

test("rejects a pull request with no selected permitted agent", () => {
  const result = validateAiContributionAttestation(
    bodyWith({ responsibility: true }),
  );

  assert.equal(result.valid, false);
  assert.match(
    result.errors.join("\n"),
    /Select at least one permitted AI agent/,
  );
});

test("rejects a pull request without the checked responsibility statement", () => {
  const result = validateAiContributionAttestation(bodyWith({ codex: true }));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /responsibility attestation/);
});

test("rejects missing, modified, or unchecked template declarations", () => {
  assert.equal(validateAiContributionAttestation(undefined).valid, false);
  assert.equal(
    validateAiContributionAttestation(
      bodyWith({ codex: true, responsibility: true }).replace(
        RESPONSIBILITY_ATTESTATION,
        "I used an agent.",
      ),
    ).valid,
    false,
  );
  assert.equal(
    validateAiContributionAttestation(
      `- [x] Another agent\n- [x] ${RESPONSIBILITY_ATTESTATION}`,
    ).valid,
    false,
  );
});
