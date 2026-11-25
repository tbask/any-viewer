# Security policy

## Supported versions

Security fixes are released for the latest published version only.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: the **Security** tab of the repository → **Report a vulnerability**
(<https://github.com/tbask/any-viewer/security/advisories/new>).

Include, as far as you can:

- the affected version and browser;
- a file or steps that reproduce the problem;
- what an attacker gains (script execution, data disclosure, denial of service).

You should receive a reply within seven days. Once a fix is released, the advisory is published
and you are credited unless you prefer otherwise.

## Scope

In scope: script execution or network requests triggered by a crafted file, escape of file content into the
host page, disclosure of data from the page that embeds the viewer.

Out of scope: the "no download button" and copy-blocking features. They are a UI convenience and are documented
as not being a protection — see [docs/security.md](./docs/security.md).
