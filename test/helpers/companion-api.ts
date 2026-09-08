/** Authenticated fetch against a running companion daemon. 对正在运行的 companion daemon 做带鉴权的 fetch。 */
export function companionFetch(
  url: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${url}${path}`, { ...init, headers });
}
