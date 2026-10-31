const APP_ORIGIN = "http://127.0.0.1:4700";

function isAppUrl(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

async function openExternalLink(value, open) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    isAppUrl(value)
  )
    return false;
  await open(url.href);
  return true;
}

module.exports = { isAppUrl, openExternalLink };
