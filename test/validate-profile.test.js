"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { escapeCommandData } = require("../src/index.js");
const {
  MAX_PROFILE_BYTES,
  ProfileValidationError,
  validateProfileFile,
  validateProfileText,
} = require("../src/validate-profile.js");

const VALID_PROFILE = [
  "schema_version: 6",
  "project:",
  "  repo: owner/name",
  "  type: public_ci_maintenance",
  "  unrelated_project_key: retained",
  "  authority:",
  "    allowed_actions:",
  "      - dev.local_test",
  "      - dev.local_edit",
  "    unrelated_authority_key: retained",
].join("\n");

function assertValidationError(callback, reason) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ProfileValidationError);
    assert.match(error.reason, reason);
    return true;
  });
}

function withWorkspace(callback) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jinsei-managed-ci-"));
  try {
    return callback(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("accepts a minimal valid profile", () => {
  const result = validateProfileText(
    [
      "schema_version: 6",
      "project:",
      "  repo: owner/name",
      "  authority:",
      "    allowed_actions:",
      "      - dev.local_test",
    ].join("\n"),
    { expectedRepository: "owner/name" },
  );

  assert.deepEqual(result, {
    repository: "owner/name",
    allowedCount: 1,
    forbiddenCount: 0,
  });
});

test("accepts optional forbidden_actions and ignores unrelated keys", () => {
  const result = validateProfileText(
    [
      "schema_version: 6",
      "unrelated_top_level_key:",
      "  nested: true",
      "project:",
      "  repo: owner/name",
      "  another_project_key: true",
      "  authority:",
      "    allowed_actions: [dev.local_test]",
      "    forbidden_actions: [dev.deploy_public]",
      "    another_authority_key: ignored",
    ].join("\n"),
  );

  assert.deepEqual(result, {
    repository: "owner/name",
    allowedCount: 1,
    forbiddenCount: 1,
  });
});

test("rejects malformed YAML without echoing profile content", () => {
  const secretMarker = "UNIQUE_PROFILE_CONTENT_MARKER";
  assertValidationError(
    () => validateProfileText(`project: [${secretMarker}`),
    /malformed YAML/u,
  );
  assert.doesNotMatch(
    (() => {
      try {
        validateProfileText(`project: [${secretMarker}`);
      } catch (error) {
        return error.message;
      }
      return "";
    })(),
    new RegExp(secretMarker, "u"),
  );
});

test("rejects duplicate YAML mapping keys", () => {
  assertValidationError(
    () =>
      validateProfileText(
        [
          "schema_version: 6",
          "schema_version: 6",
          "project:",
          "  repo: owner/name",
          "  authority:",
          "    allowed_actions: [dev.local_test]",
        ].join("\n"),
      ),
    /malformed YAML/u,
  );
});

test("rejects aliases and merge keys before validation", () => {
  assertValidationError(
    () =>
      validateProfileText(
        [
          "defaults: &defaults",
          "  schema_version: 6",
          "project:",
          "  <<: *defaults",
        ].join("\n"),
      ),
    /anchors and aliases/u,
  );
  assertValidationError(
    () =>
      validateProfileText(
        [
          "schema_version: 6",
          "project:",
          "  repo: owner/name",
          "  authority:",
          "    <<: {allowed_actions: [dev.local_test]}",
        ].join("\n"),
      ),
    /merge keys/u,
  );
});

test("rejects text and files over the 1 MiB limit before parsing", () => {
  const oversizedText = `${VALID_PROFILE}\npadding: ${"x".repeat(MAX_PROFILE_BYTES)}`;
  assertValidationError(() => validateProfileText(oversizedText), /1 MiB/u);

  withWorkspace((workspace) => {
    fs.writeFileSync(
      path.join(workspace, "PROJECT_PROFILE.yaml"),
      Buffer.alloc(MAX_PROFILE_BYTES + 1, 0x78),
    );
    assertValidationError(
      () => validateProfileFile("PROJECT_PROFILE.yaml", { workspace }),
      /1 MiB/u,
    );
  });
});

test("rejects missing, absolute, traversal, and workspace-escaping paths", () => {
  withWorkspace((workspace) => {
    assertValidationError(
      () => validateProfileFile("missing.yaml", { workspace }),
      /not found/u,
    );
    assertValidationError(
      () => validateProfileFile(path.join(workspace, "PROJECT_PROFILE.yaml"), { workspace }),
      /absolute paths/u,
    );
    assertValidationError(
      () => validateProfileFile("../outside.yaml", { workspace }),
      /traversal/u,
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jinsei-managed-ci-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "profile.yaml"), VALID_PROFILE);
      fs.symlinkSync(
        path.join(outside, "profile.yaml"),
        path.join(workspace, "linked-profile.yaml"),
      );
      assertValidationError(
        () => validateProfileFile("linked-profile.yaml", { workspace }),
        /outside the workspace/u,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("fails closed when GITHUB_WORKSPACE is unavailable", () => {
  assertValidationError(
    () => validateProfileFile("PROJECT_PROFILE.yaml", { workspace: "" }),
    /workspace is unavailable/u,
  );
});

test("requires the schema, project, authority, and action fields", () => {
  const invalidProfiles = [
    ["schema_version: 5", VALID_PROFILE.slice(VALID_PROFILE.indexOf("\n"))],
    ["schema_version: '6'", VALID_PROFILE.slice(VALID_PROFILE.indexOf("\n"))],
    ["schema_version: 6", "project: []"],
    ["schema_version: 6", "project:\n  repo: owner/name"],
    [
      "schema_version: 6",
      "project:\n  repo: owner/name\n  authority:\n    allowed_actions: not-a-list",
    ],
    [
      "schema_version: 6",
      "project:\n  repo: owner/name\n  authority:\n    allowed_actions: [dev.local_test]\n    forbidden_actions: nope",
    ],
  ];

  for (const [schema, remainder] of invalidProfiles) {
    assertValidationError(
      () => validateProfileText(`${schema}\n${remainder}`),
      /schema_version|mapping|allowed_actions|forbidden_actions/u,
    );
  }
});

test("rejects bad repository identities and GITHUB_REPOSITORY mismatches", () => {
  for (const repository of ["owner", "owner/", "/name", "owner/name/extra", "owner name/repo"]) {
    assertValidationError(
      () =>
        validateProfileText(
          VALID_PROFILE.replace("owner/name", repository),
        ),
      /owner\/name/u,
    );
  }

  assertValidationError(
    () => validateProfileText(VALID_PROFILE, { expectedRepository: "other/name" }),
    /GITHUB_REPOSITORY/u,
  );
});

test("rejects non-canonical action identifiers", () => {
  for (const action of ["", "DEV.local_test", "dev..local_test", "dev/local_test", "dev."]) {
    assertValidationError(
      () =>
        validateProfileText(
          VALID_PROFILE.replace("dev.local_test", action),
        ),
      /invalid action identifier/u,
    );
  }
});

test("rejects duplicate actions within each list and overlap across lists", () => {
  assertValidationError(
    () => validateProfileText(VALID_PROFILE.replace("      - dev.local_edit", "      - dev.local_test\n      - dev.local_edit")),
    /duplicate/u,
  );
  assertValidationError(
    () =>
      validateProfileText(
        `${VALID_PROFILE}\n    forbidden_actions: [dev.local_test]`,
      ),
    /overlap/u,
  );
  assertValidationError(
    () =>
      validateProfileText(
        `${VALID_PROFILE}\n    forbidden_actions: [dev.local_test, dev.local_test]`,
      ),
    /duplicate/u,
  );
});

test("validates a profile file and preserves only bounded failure details", () => {
  withWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, "PROJECT_PROFILE.yaml"), VALID_PROFILE);
    assert.deepEqual(
      validateProfileFile("PROJECT_PROFILE.yaml", {
        workspace,
        expectedRepository: "owner/name",
      }),
      {
        repository: "owner/name",
        allowedCount: 2,
        forbiddenCount: 0,
      },
    );
  });
});

test("escapes GitHub workflow command data", () => {
  assert.equal(
    escapeCommandData("reason:a,b\npercent%"),
    "reason%3Aa%2Cb%0Apercent%25",
  );
});
