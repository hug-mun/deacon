const configuredBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

export function appPath(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!configuredBasePath || normalizedPath === configuredBasePath || normalizedPath.startsWith(`${configuredBasePath}/`)) {
    return normalizedPath;
  }
  return `${configuredBasePath}${normalizedPath}`;
}
