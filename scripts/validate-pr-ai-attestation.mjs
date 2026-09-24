import { pathToFileURL } from "node:url";

export const CODEX_ATTESTATION = "OpenAI Codex";
export const CLAUDE_ATTESTATION = "Anthropic Claude";
export const RESPONSIBILITY_ATTESTATION =
  "I attest that I used at least one selected AI agent above for this contribution, reviewed its output, and take responsibility for the submitted changes.";

function checkedChecklistItem(label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s*\\[[xX]\\]\\s+${escapedLabel}\\s*$`, "m");
}

export function validateAiContributionAttestation(body) {
  const pullRequestBody = typeof body === "string" ? body : "";
  const selectedAgents = [CODEX_ATTESTATION, CLAUDE_ATTESTATION].filter(
    (agent) => checkedChecklistItem(agent).test(pullRequestBody),
  );
  const responsibilityAccepted = checkedChecklistItem(
    RESPONSIBILITY_ATTESTATION,
  ).test(pullRequestBody);
  const errors = [];

  if (selectedAgents.length === 0) {
    errors.push(
      "Select at least one permitted AI agent in the pull request body: OpenAI Codex or Anthropic Claude.",
    );
  }

  if (!responsibilityAccepted) {
    errors.push(
      "Check the required AI-agent responsibility attestation in the pull request body.",
    );
  }

  return {
    valid: errors.length === 0,
    selectedAgents,
    responsibilityAccepted,
    errors,
  };
}

function run() {
  const result = validateAiContributionAttestation(process.env.PR_BODY);

  if (!result.valid) {
    console.error("AI-agent contribution policy check failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    console.error(
      "Edit the pull request description, keep the required attestation section, and rerun the failed check.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `AI-agent contribution policy satisfied with: ${result.selectedAgents.join(", ")}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
}
