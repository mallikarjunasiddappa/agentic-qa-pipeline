/**
 * A test's suite is its first directory under tests/, e.g. "tests/auth/x.spec.ts" -> "auth",
 * "tests/student/y.spec.ts" -> "student". Mechanical, never typed by the Healer Agent.
 */
export function deriveSuite(testFilePath: string): string {
  const parts = testFilePath.replace(/\\/g, '/').split('/');
  const testsIndex = parts.indexOf('tests');
  if (testsIndex === -1 || testsIndex + 1 >= parts.length) {
    throw new Error(
      `Cannot derive a suite from "${testFilePath}" - expected a path under tests/<suite>/...`,
    );
  }
  return parts[testsIndex + 1];
}
