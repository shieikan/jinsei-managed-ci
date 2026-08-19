"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const MAX_PROFILE_BYTES = 1024 * 1024;
const DEFAULT_PROFILE_PATH = "PROJECT_PROFILE.yaml";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;

class ProfileValidationError extends Error {
  constructor(reason, pathLabel = "") {
    const safeReason = String(reason).slice(0, 160);
    const safeLabel = pathLabel ? ` '${String(pathLabel).slice(0, 160)}'` : "";
    super(`profile${safeLabel}: ${safeReason}`);
    this.name = "ProfileValidationError";
    this.reason = safeReason;
  }
}

function fail(reason) {
  throw new ProfileValidationError(reason);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isMapping(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTokenBoundary(character) {
  return character === undefined || /[\s\[\]{}?,:]/u.test(character);
}

function rejectUnsafeYamlTokens(source) {
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote === "'") {
      if (character === "'" && source[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }

    if (character === "#" && (index === 0 || /\s/u.test(source[index - 1]))) {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }

    if ((character === "&" || character === "*") && isTokenBoundary(source[index - 1])) {
      fail("anchors and aliases are not allowed");
    }

    if (
      character === "<" &&
      source[index + 1] === "<" &&
      isTokenBoundary(source[index - 1])
    ) {
      let next = index + 2;
      while (/\s/u.test(source[next] || "")) {
        next += 1;
      }
      if (source[next] === ":") {
        fail("merge keys are not allowed");
      }
    }
  }
}

function parseProfileText(profileText) {
  if (typeof profileText !== "string") {
    fail("profile must be text");
  }
  if (Buffer.byteLength(profileText, "utf8") > MAX_PROFILE_BYTES) {
    fail("profile exceeds the 1 MiB limit");
  }

  rejectUnsafeYamlTokens(profileText);

  try {
    return yaml.load(profileText, {
      json: false,
      schema: yaml.CORE_SCHEMA,
    });
  } catch (_error) {
    fail("malformed YAML");
  }
}

function validateActionList(value, fieldName) {
  if (!Array.isArray(value)) {
    fail(`${fieldName} must be a list`);
  }

  const seen = new Set();
  for (const action of value) {
    if (typeof action !== "string" || !ACTION_PATTERN.test(action)) {
      fail(`${fieldName} contains an invalid action identifier`);
    }
    if (seen.has(action)) {
      fail(`${fieldName} contains duplicate action identifiers`);
    }
    seen.add(action);
  }

  return value;
}

function validateProfileObject(profile, { expectedRepository = "" } = {}) {
  if (!isMapping(profile)) {
    fail("root must be a mapping");
  }

  if (
    !hasOwn(profile, "schema_version") ||
    typeof profile.schema_version !== "number" ||
    !Number.isInteger(profile.schema_version) ||
    profile.schema_version !== 6
  ) {
    fail("schema_version must be integer 6");
  }

  if (!hasOwn(profile, "project") || !isMapping(profile.project)) {
    fail("project must be a mapping");
  }

  const project = profile.project;
  if (
    typeof project.repo !== "string" ||
    !REPOSITORY_PATTERN.test(project.repo)
  ) {
    fail("project.repo must be an owner/name string");
  }

  if (expectedRepository && project.repo !== expectedRepository) {
    fail("project.repo does not match GITHUB_REPOSITORY");
  }

  if (!hasOwn(project, "authority") || !isMapping(project.authority)) {
    fail("project.authority must be a mapping");
  }

  const authority = project.authority;
  const allowedActions = validateActionList(
    authority.allowed_actions,
    "allowed_actions",
  );
  const forbiddenActions = hasOwn(authority, "forbidden_actions")
    ? validateActionList(authority.forbidden_actions, "forbidden_actions")
    : [];
  const allowedSet = new Set(allowedActions);

  if (forbiddenActions.some((action) => allowedSet.has(action))) {
    fail("allowed_actions and forbidden_actions overlap");
  }

  return {
    repository: project.repo,
    allowedCount: allowedActions.length,
    forbiddenCount: forbiddenActions.length,
  };
}

function validateProfileText(profileText, options = {}) {
  return validateProfileObject(parseProfileText(profileText), options);
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function displayPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "<invalid>";
  }
  const sanitized = value.replace(/[\r\n\t]/gu, "?");
  return sanitized.length > 160 ? `${sanitized.slice(0, 157)}...` : sanitized;
}

function pathFailure(reason, value) {
  throw new ProfileValidationError(reason, displayPath(value));
}

function validateProfileFile(profilePath, {
  workspace = process.env.GITHUB_WORKSPACE || "",
  expectedRepository = "",
} = {}) {
  if (typeof profilePath !== "string" || profilePath.length === 0) {
    pathFailure("path must be a non-empty relative path", profilePath);
  }
  if (path.isAbsolute(profilePath) || path.win32.isAbsolute(profilePath)) {
    pathFailure("absolute paths are not allowed", profilePath);
  }
  if (profilePath.split(/[\\/]/u).includes("..")) {
    pathFailure("path traversal is not allowed", profilePath);
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    pathFailure("workspace is unavailable", profilePath);
  }

  const workspaceRoot = path.resolve(workspace);
  const candidate = path.resolve(workspaceRoot, profilePath);
  if (!isWithinDirectory(workspaceRoot, candidate)) {
    pathFailure("path escapes the workspace", profilePath);
  }

  let realWorkspace;
  let realCandidate;
  try {
    realWorkspace = fs.realpathSync(workspaceRoot);
    realCandidate = fs.realpathSync(candidate);
  } catch (_error) {
    pathFailure("profile file was not found", profilePath);
  }

  if (!isWithinDirectory(realWorkspace, realCandidate)) {
    pathFailure("path resolves outside the workspace", profilePath);
  }

  let stat;
  try {
    stat = fs.statSync(realCandidate);
  } catch (_error) {
    pathFailure("profile file could not be inspected", profilePath);
  }
  if (!stat.isFile()) {
    pathFailure("profile path is not a regular file", profilePath);
  }
  if (stat.size > MAX_PROFILE_BYTES) {
    pathFailure("profile exceeds the 1 MiB limit", profilePath);
  }

  let profileText;
  try {
    profileText = fs.readFileSync(realCandidate, "utf8");
  } catch (_error) {
    pathFailure("profile file could not be read", profilePath);
  }
  if (Buffer.byteLength(profileText, "utf8") > MAX_PROFILE_BYTES) {
    pathFailure("profile exceeds the 1 MiB limit", profilePath);
  }

  try {
    return validateProfileText(profileText, { expectedRepository });
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      throw new ProfileValidationError(error.reason, displayPath(profilePath));
    }
    throw new ProfileValidationError("profile validation failed", displayPath(profilePath));
  }
}

module.exports = {
  ACTION_PATTERN,
  DEFAULT_PROFILE_PATH,
  MAX_PROFILE_BYTES,
  ProfileValidationError,
  validateProfileFile,
  validateProfileObject,
  validateProfileText,
};
