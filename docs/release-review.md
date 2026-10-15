# Release review — 2026-10-14

## Scope

The functional baseline is `51833d5`.
The review covers the recent motion changes, Codex lifecycle, aircraft presenter,
display ownership, button dismissal, location helper, traffic stream, credentials,
and service installation.

The release change renames the project to `busy-bar-toys` and adds equivalent
English and Chinese installation guides. The CLI remains `busy-bar`.
Keychain service names and private runtime paths retain their existing identities.

## Findings

An independent reviewer found no confirmed P1 or P2 issues in the functional code
or the release diff. No code fixes were required for this release.

The project requires an editable source installation. The installation guide
states this requirement and explains that the checkout must remain available.
Moving the checkout requires an editable reinstall and a service reinstall.

## Verification

- All 166 tests passed in fresh local runs before and after the directory move.
- Fresh imports, the CLI entry point, package metadata, and helper paths use the new checkout.
- The launchd working directory and interpreter use the new checkout.
- The service, cloud device connection, ADSBao stream, and Wi-Fi input report healthy status after migration.
- Both READMEs contain the same 17 shell commands and five inline commands.
- Local links in both READMEs resolve.
- A scan covered 492 reachable Git objects for common credential patterns and private location literals.
- Exact comparisons against both active Keychain tokens found no matches in 264 reachable blobs.
- Tracked history contains no runtime or authorization files.

The independent reviewer did not read live credentials or contact the device.
The exact-token comparison and runtime checks were separate local checks.
The scan does not certify that every possible secret format has been identified.

## Documentation

The English guide uses ASD-STE100 writing principles: short sentences, direct
instructions, and consistent terms. The Chinese guide uses the same procedures.
Product names and code identifiers retain their required spelling.

The animation preview uses mock flight data. Device captures are identified as
actual framebuffer samples from a synthetic demonstration. See the
[motion verification record](weighted-motion.md) for evidence and sampling limits.
