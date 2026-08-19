"use strict";

const {
  DEFAULT_PROFILE_PATH,
  ProfileValidationError,
  validateProfileFile,
} = require("./validate-profile.js");

function escapeCommandData(value) {
  return String(value)
    .replace(/%/gu, "%25")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A")
    .replace(/:/gu, "%3A")
    .replace(/,/gu, "%2C");
}

function main() {
  const profilePath = process.env.INPUT_PROFILE_PATH || DEFAULT_PROFILE_PATH;
  const workspace = process.env.GITHUB_WORKSPACE || "";
  const expectedRepository = process.env.GITHUB_REPOSITORY || "";

  try {
    const result = validateProfileFile(profilePath, {
      workspace,
      expectedRepository,
    });
    console.log(
      `Validated ${result.repository}: ${result.allowedCount} allowed, ${result.forbiddenCount} forbidden`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof ProfileValidationError
      ? error.message
      : "profile validation failed";
    process.stderr.write(`::error::${escapeCommandData(message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  escapeCommandData,
  main,
};
