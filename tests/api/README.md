# API Tests

API spec files go here, mirroring the target API's resource/endpoint structure - the API
equivalent of how `tests/ui/` mirrors the app's URL structure (see `CLAUDE.md`'s "When adding a
new test" section).

Import `test`/`expect` from `src/api/fixtures/` (once it has a real base fixture), not
`src/ui/fixtures/` or `@playwright/test` directly - same "no import test directly from
`@playwright/test`" rule that applies to UI tests.

This file is a placeholder so the empty directory persists in git - replace/remove it once real
API spec files exist here.
