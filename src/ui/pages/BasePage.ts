import type { Page } from '@playwright/test';

export class BasePage {
  // Not `readonly` - TestPrepPage/PracticeTestPage (KAN-7) temporarily repoint `this.page` at a
  // popup tab for the duration of a call, then restore it, mirroring the original
  // original implementation. Every other existing page object only ever reads `this.page`
  // and is unaffected by dropping `readonly`.
  constructor(protected page: Page) {}
}
