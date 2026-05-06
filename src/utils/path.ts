/**
 * Extract filename from a path. Handles both Windows (\) and Unix (/) separators.
 */
export const getFilename = (path: string): string =>
  path.split(/[\\/]/).pop() ?? "";

/**
 * Extract folder portion from a file path. Handles both Windows (\) and Unix (/) separators.
 * Returns an empty string if no separator is found.
 */
export const getFolderPath = (path: string): string => {
  const lastSlashIndex = Math.max(
    path.lastIndexOf("\\"),
    path.lastIndexOf("/"),
  );
  return lastSlashIndex < 0 ? "" : path.substring(0, lastSlashIndex);
};
