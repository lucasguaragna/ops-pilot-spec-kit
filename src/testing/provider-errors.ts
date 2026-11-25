/**
 * Test helper: an error shaped like the ones the OpenAI client throws, with a numeric `status` and a
 * class-like `name`, as `retryFailedCall` reads them.
 */
export function providerError(status: number, name: string, message = `provider error ${status}`): Error {
  const error = Object.assign(new Error(message), { status });
  error.name = name;
  return error;
}
