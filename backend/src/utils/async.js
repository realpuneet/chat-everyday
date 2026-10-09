export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async fn, never throw (used for best-effort side effects). */
export async function safe(fn, onError) {
  try {
    return await fn();
  } catch (e) {
    onError?.(e);
    return undefined;
  }
}
