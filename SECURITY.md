# Security policy

## Supported versions

Humans is pre-release software. Security fixes are applied to the latest revision of the default branch; no released version is currently supported.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, or pull request. If the repository's **Security** tab shows **Report a vulnerability**, use that private route. Its availability is not yet verified. Otherwise, contact a verified repository maintainer privately through the hosting platform before sharing details.

Include the affected revision, deployment mode, reproduction steps, impact, and any suggested mitigation. Remove personal data and live credentials from evidence. Maintainers will acknowledge receipt, coordinate validation and remediation, and credit reporters who request attribution when disclosure is safe.

## Security expectations

- Never commit credentials or real research data.
- Use synthetic fixtures in tests and documentation.
- Preserve workspace isolation and record-level authorization in every data path.
- Report leaked credentials immediately and rotate them; deleting them from Git history is not sufficient.
