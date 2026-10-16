# Security Policy

## Reporting a Vulnerability

**Report-only**: to report a security issue, open a GitHub issue on this
repository with the `security` label, or contact the maintainer via their
GitHub profile at <https://github.com/shubham-dg10>. Do not open a
vulnerability report as a public blog post or discussion before the
maintainer has had a reasonable chance to respond.

Include: affected file(s), steps to reproduce, and the impact you see.
A minimal proof-of-concept is welcome; an exploit against live systems
is not.

## Ground Rules

- **Redact secrets**: never paste API keys, tokens, passwords, or customer
  data into issues, logs, or reproductions. Scrub `checkpoint.json` and
  worker logs before sharing.
- **Authorized targets only**: test against systems you own or are
  explicitly permitted to test. The scanner and audit scenarios in this
  repo are for your own codebases — do not point them at third parties.
- **No live exploitation**: demonstrate impact against local fixtures,
  not production endpoints.
