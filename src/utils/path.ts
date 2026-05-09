/**
 * Extract filename from a path. Handles both Windows (\) and Unix (/) separators.
 */
export const getFilename = (path: string): string =>
  path.split(/[\\/]/).pop() ?? "";

/**
 * Extract folder portion from a file path. Handles both Windows (\) and Unix (/) separators.
 * Returns an empty string if no separator is found. Preserves the trailing separator for
 * filesystem roots ("/file" -> "/", "C:\\file" -> "C:\\") so the result is a usable directory.
 */
export const getFolderPath = (path: string): string => {
  const lastSlashIndex = Math.max(
    path.lastIndexOf("\\"),
    path.lastIndexOf("/"),
  );
  if (lastSlashIndex < 0) return "";

  const isUnixRoot = lastSlashIndex === 0;
  const isWindowsDriveRoot = lastSlashIndex === 2 && path[1] === ":";
  if (isUnixRoot || isWindowsDriveRoot) {
    return path.substring(0, lastSlashIndex + 1);
  }
  return path.substring(0, lastSlashIndex);
};
