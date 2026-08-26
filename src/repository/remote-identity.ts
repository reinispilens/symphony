export interface RemoteIdentity {
  readonly hostname: string;
  readonly repositoryIdentity: string;
}

/** Parse the repository identity from an HTTPS, SSH URL, or SCP-style Git remote. */
export function parseRemoteIdentity(remoteUrl: string): RemoteIdentity | null {
  let normalized = remoteUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  let hostname: string | null = null;
  const scp = normalized.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/u);
  if (scp !== null && !normalized.includes("://")) {
    hostname = scp[1]?.toLowerCase() ?? null;
    normalized = scp[2] ?? normalized;
  }
  try {
    if (normalized.includes("://")) {
      const parsed = new URL(normalized);
      hostname = parsed.host.toLowerCase();
      normalized = parsed.pathname;
    }
  } catch {
    return null;
  }
  if (hostname === null || hostname === "") return null;
  const segments = normalized
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  return {
    hostname,
    repositoryIdentity: `${segments.at(-2)}/${segments.at(-1)}`,
  };
}
