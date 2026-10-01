/**
 * The generic contract every per-app test-data factory implements - application-independent by
 * construction. A booking isn't a bank account isn't a subscription, so this deliberately says
 * nothing about *what* T is or how create/cleanup talk to the app's API; that stays per-app (see
 * src/api/testData/booking.ts), the same way src/ui/pages/* stays per-app under the Page Object
 * Contract.
 */
export interface TestDataFactory<T> {
  readonly entityName: string;
  create(overrides?: Partial<T>): Promise<T>;
  cleanup(entity: T): Promise<void>;
}
