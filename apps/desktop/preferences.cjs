async function saveLanguage(session, locale, now = Date.now()) {
  if (!["ja", "en"].includes(locale)) throw new Error("Invalid language");
  // Match the Web preference cookie so Electron can update an existing HttpOnly value.
  await session.cookies.set({
    url: "http://127.0.0.1:4700/",
    name: "sacty-lang",
    value: locale,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expirationDate: now / 1000 + 365 * 24 * 60 * 60,
  });
  await session.cookies.flushStore();
}

module.exports = { saveLanguage };
