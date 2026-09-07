# Portfolio publication review

Prepared September 7, 2026. Scope: privacy, secret exposure, publication packaging, and preservation of the useful implementation. This is not a comprehensive vulnerability audit or a certification of live-service security.

## Export policy

The public repository is a fresh snapshot, not a fork or a branch of the private repository. No original Git objects, commit metadata, branches, tags, issues, CI logs, database contents, or ignored local files were imported.

Included: application TypeScript, SQL migrations, OpenAPI, versioned synthetic evaluation scenarios, core tests, the evaluation harness and its mocked tests, and pure reconciliation-evidence validation.

Excluded: production and incident histories, operator runbooks, deployment checklists, account setup, credential/DPAPI handoff tools, production probes, monitoring and email jobs, and tests dedicated to those excluded tools. Public documentation was written for this snapshot instead of copying internal operational notes.

Production service/contact addresses were replaced with reserved examples. The database UUID is a placeholder; the Worker and database have portfolio names. Deployment and remote-migration package scripts were removed. Public previews/workers.dev publication and traces are disabled. Generated binding types were regenerated from the sanitized configuration.

## Review method

- Inventory every publication file, including dotfiles, lockfiles, tests, configuration, and generated bindings.
- Check for original database/payment identifiers, production domains and escaped variants, personal paths, contact addresses, credential files, and common secret patterns.
- Review remaining URLs, wallet-like values, UUIDs, and synthetic privacy fixtures in context. Public protocol addresses and deterministic test data are not operator credentials.
- Run Gitleaks against the exact publication candidate with redacted output; assess any matches before publishing.
- Check Markdown links, fresh root history, commit identity, the files actually staged, and preservation of the private source state.

## Validation

The final targeted publication scan found no prohibited files, production identifiers, personal paths, or broken local documentation links. Gitleaks 8.30.1 reported two generic-key matches; both are the same synthetic UUID used as an `Idempotency-Key` in a mocked integration test. They were reviewed as test identifiers, not credentials. No unresolved secret finding remained.

Local validation passed TypeScript checking, **300 tests across 18 files**, and a Wrangler dry-run bundle. Tests use mocked external effects and local databases; no production payment, inference, deployment, or remote migration was performed. CI runs the same offline gate; the current GitHub Actions result should be checked for the commit being reviewed.

## Rights and limitations

The project declares `UNLICENSED` and remains a private npm package to prevent accidental package publication. No open-source license is granted for original project material. Existing third-party license metadata and generated notices are preserved; see [NOTICE.md](../NOTICE.md).

Secret scanners cannot prove the absence of every possible disclosure. The public copy is an inspectable work sample and requires independent configuration and review before any operational use. This review makes no claim about current production state or live model accuracy.
