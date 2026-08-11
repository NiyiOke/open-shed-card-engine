import assert from "node:assert/strict";
import test from "node:test";
import {
  parseV15FeaturePolicy,
  V15_FEATURE_ENV,
  type V15FeatureEnvironment,
} from "../lib/server/v15-feature-policy";

test("V1.5 capabilities default off in production", () => {
  assert.deepEqual(parseV15FeaturePolicy({ NODE_ENV: "production" }), {
    discoveryEnabled: false,
    communicationEnabled: false,
    freeTextEnabled: false,
  });
});

test("V1.5 capabilities also default off outside production", () => {
  assert.deepEqual(parseV15FeaturePolicy({ NODE_ENV: "development" }), {
    discoveryEnabled: false,
    communicationEnabled: false,
    freeTextEnabled: false,
  });
});

test("discovery and curated communication can be enabled independently", () => {
  assert.deepEqual(
    parseV15FeaturePolicy({
      [V15_FEATURE_ENV.discovery]: "true",
    }),
    {
      discoveryEnabled: true,
      communicationEnabled: false,
      freeTextEnabled: false,
    },
  );

  assert.deepEqual(
    parseV15FeaturePolicy({
      [V15_FEATURE_ENV.communication]: "true",
    }),
    {
      discoveryEnabled: false,
      communicationEnabled: true,
      freeTextEnabled: false,
    },
  );
});

test("free text remains off unless communication is explicitly enabled", () => {
  assert.deepEqual(
    parseV15FeaturePolicy({
      [V15_FEATURE_ENV.freeText]: "true",
    }),
    {
      discoveryEnabled: false,
      communicationEnabled: false,
      freeTextEnabled: false,
    },
  );
});

test("all three capabilities require their exact explicit enablement", () => {
  assert.deepEqual(
    parseV15FeaturePolicy({
      NODE_ENV: "production",
      [V15_FEATURE_ENV.discovery]: "true",
      [V15_FEATURE_ENV.communication]: "true",
      [V15_FEATURE_ENV.freeText]: "true",
    }),
    {
      discoveryEnabled: true,
      communicationEnabled: true,
      freeTextEnabled: true,
    },
  );
});

test("free text rejects loose values even when communication is enabled", () => {
  for (const value of ["TRUE", "1", "yes", "on", " true "]) {
    assert.deepEqual(
      parseV15FeaturePolicy({
        [V15_FEATURE_ENV.communication]: "true",
        [V15_FEATURE_ENV.freeText]: value,
      }),
      {
        discoveryEnabled: false,
        communicationEnabled: true,
        freeTextEnabled: false,
      },
    );
  }
});

test("unknown or loosely truthy values fail closed", () => {
  for (const value of ["TRUE", "1", "yes", "on", " true ", "false", ""]) {
    const environment: V15FeatureEnvironment = {
      [V15_FEATURE_ENV.discovery]: value,
      [V15_FEATURE_ENV.communication]: value,
      [V15_FEATURE_ENV.freeText]: value,
    };

    assert.deepEqual(parseV15FeaturePolicy(environment), {
      discoveryEnabled: false,
      communicationEnabled: false,
      freeTextEnabled: false,
    });
  }
});

test("the pure parser does not mutate its input and freezes its result", () => {
  const environment: V15FeatureEnvironment = {
    [V15_FEATURE_ENV.discovery]: "true",
    [V15_FEATURE_ENV.communication]: "true",
  };
  const before = { ...environment };

  const policy = parseV15FeaturePolicy(environment);

  assert.deepEqual(environment, before);
  assert.equal(Object.isFrozen(policy), true);
});
