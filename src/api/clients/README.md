# API Clients

One class per API resource/endpoint group - the API automation equivalent of a UI page object.

Convention to follow once real clients land here (mirrors the Page Object Contract in `CLAUDE.md`):

- One class per resource (e.g. `BookingsApiClient`, `UsersApiClient`), not one giant client.
- Constructor takes whatever's needed to make requests (base URL, auth token/context) - keep it
  minimal and explicit, not a grab-bag of globals.
- Request methods return the parsed response data (or a typed result), not raw `expect()` calls -
  assertions belong in the test, same rule as UI page objects.
- Reuse `src/api/testData/` factories for creating/cleaning up data a test needs, rather than each
  client re-implementing its own setup/teardown.

This file is a placeholder so the empty directory persists in git - replace/remove it once real
clients exist here.
