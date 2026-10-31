const { isAppUrl } = require("./links.cjs");

function notificationPermissions(expectedContents, enabled) {
  const trusted = (contents, permission, url, details = {}) =>
    enabled &&
    contents === expectedContents &&
    !contents.isDestroyed() &&
    permission === "notifications" &&
    isAppUrl(contents.getURL()) &&
    isAppUrl(url) &&
    details.isMainFrame !== false &&
    (!details.embeddingOrigin || isAppUrl(details.embeddingOrigin));
  return {
    check: (contents, permission, origin, details) =>
      trusted(contents, permission, origin, details),
    request: (contents, permission, callback, details = {}) =>
      callback(trusted(contents, permission, details.requestingUrl, details)),
  };
}

module.exports = { notificationPermissions };
