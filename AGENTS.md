# jinsei-managed-ci/AGENTS.md

This repository contains only a read-only GitHub Action and its tests. Work in
this repository is limited to sanitized public CI maintenance: inspect files,
edit the action or documentation, run tests/builds, and create a local commit.
An existing-repository push or pull request may be prepared only under the
normal Jinsei authority and review gates.

The action reads a caller repository's `PROJECT_PROFILE.yaml` and reports
schema or safety-contract failures. It does not copy the Jinsei runtime,
central configuration, task state, history, or authority registry.

Do not add repository-creation, visibility, release, deployment, secret,
billing, destructive, background-service, scheduler, plugin, API, or second
control-plane behavior. Do not log profile contents, credentials, tokens, or
private runtime data. Keep dependency and GitHub Action references pinned and
reviewable.
