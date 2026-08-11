/**
 * Environment-controlled V1.5 safety policy.
 *
 * Every capability is fail-closed: only the exact value `true` enables a
 * feature. Free text has an additional dependency on table communication so a
 * partial or stale environment configuration cannot expose an unmoderated
 * input surface on its own.
 */
export const V15_FEATURE_ENV = {
  discovery: "OPEN_SHED_V15_DISCOVERY_ENABLED",
  communication: "OPEN_SHED_V15_COMMUNICATION_ENABLED",
  freeText: "OPEN_SHED_V15_FREE_TEXT_ENABLED",
} as const;

export type V15FeatureEnvironmentKey =
  (typeof V15_FEATURE_ENV)[keyof typeof V15_FEATURE_ENV];

export type V15FeatureEnvironment = Partial<
  Record<V15FeatureEnvironmentKey | "NODE_ENV", string | undefined>
>;

type CommunicationDisabledPolicy = Readonly<{
  discoveryEnabled: boolean;
  communicationEnabled: false;
  freeTextEnabled: false;
}>;

type CommunicationEnabledPolicy = Readonly<{
  discoveryEnabled: boolean;
  communicationEnabled: true;
  freeTextEnabled: boolean;
}>;

export type V15FeaturePolicy =
  | CommunicationDisabledPolicy
  | CommunicationEnabledPolicy;

/** Pure parser used by tests and server integrations. */
export function parseV15FeaturePolicy(
  environment: V15FeatureEnvironment,
): V15FeaturePolicy {
  const discoveryEnabled = isExplicitlyEnabled(
    environment[V15_FEATURE_ENV.discovery],
  );
  const communicationEnabled = isExplicitlyEnabled(
    environment[V15_FEATURE_ENV.communication],
  );

  if (!communicationEnabled) {
    return Object.freeze({
      discoveryEnabled,
      communicationEnabled: false,
      freeTextEnabled: false,
    });
  }

  return Object.freeze({
    discoveryEnabled,
    communicationEnabled: true,
    freeTextEnabled: isExplicitlyEnabled(
      environment[V15_FEATURE_ENV.freeText],
    ),
  });
}

/** Reads the current server environment without caching rollout state. */
export function getV15FeaturePolicy(): V15FeaturePolicy {
  return parseV15FeaturePolicy(process.env);
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === "true";
}
