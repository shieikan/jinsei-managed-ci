# Jinsei managed-repository contract action

This public, read-only GitHub Action validates the caller repository's
`PROJECT_PROFILE.yaml` authority contract. It is intentionally a thin CI
consumer: it does not include the Jinsei runtime, central configuration,
SQLite state, history, action registry, service process, scheduler, plugin
framework, or a second control plane.

## Caller usage

Pin both the checkout and this action to immutable full commit SHAs. The
40-zero values below are placeholders, not mutable tags; replace them with
the reviewed commit SHAs before use.

```yaml
name: Jinsei contract

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  validate-profile:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000
      - uses: shieikan/jinsei-managed-ci@0000000000000000000000000000000000000000
        with:
          profile_path: PROJECT_PROFILE.yaml
```

`profile_path` is optional and must be a relative path under
`GITHUB_WORKSPACE`; the default is `PROJECT_PROFILE.yaml`. Absolute paths,
traversal, workspace-escaping symlinks, files larger than 1 MiB, malformed
YAML, aliases, merge keys, duplicate mapping keys, and invalid authority
entries fail closed.

The required contract has `schema_version: 6`, a `project` mapping with an
`owner/name` repository identity and an `authority` mapping, plus an
`allowed_actions` list. `forbidden_actions` is optional and defaults to an
empty list. Action identifiers are lower-case ASCII dotted identifiers using
letters, digits, `_`, and `-`; duplicates and overlap are rejected. Unrelated
top-level and project keys remain caller-owned and are not rejected. The
validator checks structure and safety only; it does not maintain a duplicate
central action allowlist.

When `GITHUB_REPOSITORY` is set, the profile repository identity must match it
exactly. A successful run reports only the repository identity and allowed or
forbidden counts. Failures report a bounded path and reason without echoing the
profile content.

## Scope boundary

This action reads one caller-controlled profile during CI and emits a status
message. It does not read secrets, call APIs, publish artifacts, change
repository visibility, create repositories, deploy, release, mutate external
state, or perform Git operations. Repository-specific build, test, release,
and deployment workflows remain local to the caller repository and are outside
this action's scope.

The repository's own workflow has read-only `contents` permissions and pins
`actions/checkout` to a full commit SHA. Dependabot checks GitHub Action and npm
dependencies weekly; dependency or action updates still require normal review
and verification.

## Local development

```sh
npm ci
npm test
npm run build
npm run check:dist
```

`dist/index.js` is a committed generated artifact so callers do not install
dependencies. `npm run check:dist` rebuilds the bundle and checks that the
committed artifact has no diff.

