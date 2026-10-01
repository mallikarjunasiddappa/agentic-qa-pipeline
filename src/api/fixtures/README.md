# API Fixtures

The API equivalent of `src/ui/fixtures/` - a `test`/`expect` export API spec files import from,
per `CLAUDE.md`'s "import test from the relevant domain's base fixture" rule.

The key difference from the UI base fixture: API tests generally don't need a browser at all.
Playwright's built-in `request` fixture makes pure HTTP calls with no browser context, which is
significantly faster and cheaper to run than spinning up a `page` for tests that never touch a
DOM. When the first real API base fixture lands here, prefer extending Playwright's `request`
fixture (or wrapping it with authentication) rather than reusing `src/ui/fixtures/base.ts`, whose
`page` fixture unconditionally navigates a browser to `APP_BASE_URL`.

This file is a placeholder so the empty directory persists in git - replace/remove it once a real
base fixture exists here.
