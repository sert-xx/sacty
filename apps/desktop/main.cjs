const { app, BrowserWindow, ipcMain, dialog, shell, session } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { isAppUrl, openExternalLink } = require("./links.cjs");
const { notificationPermissions } = require("./permissions.cjs");
const { captureDiagnostics } = require("./diagnostics.cjs");
const { createShutdownHandler } = require("./shutdown.cjs");
const { saveLanguage } = require("./preferences.cjs");
const { pickLocale, messagesFor, text } = require("./messages.cjs");
const {
  runtimePaths,
  prepare,
  launch,
  waitForScreen,
  stopChild,
  saveApiKey,
  redact,
} = require("./runtime.cjs");

let setup;
let screen;
let child;
let busy = false;
let quitting = false;
let paths;
let preparation;
let diagnostics;
let locale = "ja";
const t = (key, values) => text(locale, key, values);
const setupUrl = pathToFileURL(join(__dirname, "setup.html")).href;

function secureWindow(preload) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    title: "Sacty",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      ...(preload ? { preload } : {}),
    },
  });
  const openInBrowser = (target) => {
    if (!preload)
      openExternalLink(target, (url) => shell.openExternal(url)).catch(() => {
        dialog.showErrorBox("Sacty", t("linkFailed"));
      });
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const restrictNavigation = (event, target) => {
    if (preload || !isAppUrl(target)) {
      event.preventDefault();
      openInBrowser(target);
    }
  };
  win.webContents.on("will-navigate", restrictNavigation);
  win.webContents.on("will-redirect", (event, target) => {
    if (preload || !isAppUrl(target)) event.preventDefault();
  });
  const permissions = notificationPermissions(win.webContents, !preload);
  win.webContents.session.setPermissionRequestHandler(permissions.request);
  win.webContents.session.setPermissionCheckHandler(permissions.check);
  return win;
}

function validateSender(event) {
  if (!setup || event.sender !== setup.webContents || event.senderFrame?.url !== setupUrl)
    throw new Error(t("invalidOperation"));
}

async function showSetup() {
  setup = secureWindow(join(__dirname, "preload.cjs"));
  setup.on("closed", () => {
    setup = undefined;
  });
  await setup.loadFile(join(__dirname, "setup.html"));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const win = screen || setup;
    if (win) {
      win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const preferred = (
        await session.defaultSession.cookies.get({
          url: "http://127.0.0.1:4700",
          name: "sacty-lang",
        })
      )[0]?.value;
      locale = preferred === "ja" || preferred === "en" ? preferred : pickLocale(app.getLocale());
      paths = runtimePaths(
        app.isPackaged ? process.resourcesPath : undefined,
        join(__dirname, "../.."),
        locale,
      );
      ipcMain.handle("desktop:settings", (event) => {
        validateSender(event);
        return { locale, messages: messagesFor(locale) };
      });
      ipcMain.handle("desktop:language", async (event, value) => {
        validateSender(event);
        if (busy || !["ja", "en"].includes(value)) throw new Error(t("invalidOperation"));
        await saveLanguage(session.defaultSession, value);
        locale = value;
        return { locale, messages: messagesFor(locale) };
      });
      ipcMain.handle("desktop:secret", async (event, value) => {
        validateSender(event);
        try {
          await saveApiKey(value, undefined, locale);
          return { ok: true };
        } catch {
          return {
            ok: false,
            message: t("keyFailed"),
          };
        }
      });
      ipcMain.handle("desktop:help", (event) => {
        validateSender(event);
        return shell.openExternal(
          `https://github.com/sert-xx/sacty/blob/main/docs/user/getting-started${locale === "en" ? ".en" : ""}.md`,
        );
      });
      ipcMain.handle("desktop:start", async (event) => {
        validateSender(event);
        if (busy || child) return { ok: false, message: t("busy") };
        busy = true;
        diagnostics = undefined;
        const progress = (message) => {
          if (setup && !setup.isDestroyed()) setup.webContents.send("desktop:progress", message);
        };
        try {
          preparation = new AbortController();
          await prepare(paths, progress, preparation.signal, {
            locale,
            confirmMigration: async ({ from, to }) => {
              const answer = await dialog.showMessageBox(setup, {
                type: "question",
                title: "Sacty",
                message: t("updateHelp", { from, to }),
                detail: t("updateHint"),
                buttons: [t("updateConfirm"), t("cancel")],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              });
              return answer.response === 0;
            },
          });
          progress(t("starting"));
          child = launch(paths);
          diagnostics = captureDiagnostics(child);
          const url = await waitForScreen(child, { locale });
          screen = secureWindow();
          await screen.loadURL(url);
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(t("exited"));
          const runningChild = child;
          const runningDiagnostics = diagnostics;
          runningChild.once("exit", async () => {
            await runningDiagnostics.waitForClose();
            if (child !== runningChild) return;
            child = undefined;
            if (!quitting) {
              dialog.showErrorBox(
                "Sacty",
                [t("exited"), diagnostics?.text()].filter(Boolean).join("\n\n"),
              );
              app.quit();
            }
          });
          screen.on("closed", () => {
            screen = undefined;
            app.quit();
          });
          setup?.close();
          return { ok: true };
        } catch (error) {
          screen?.destroy();
          screen = undefined;
          await stopChild(child);
          await diagnostics?.waitForClose();
          child = undefined;
          return {
            ok: false,
            message: redact(error instanceof Error ? error.message : t("startFailed")),
            diagnostics: diagnostics?.text() || "",
          };
        } finally {
          busy = false;
          preparation = undefined;
        }
      });
      await showSetup();
    })
    .catch((error) => {
      dialog.showErrorBox("Sacty", error.message);
      app.quit();
    });
  app.on(
    "before-quit",
    createShutdownHandler({
      getChild: () => child,
      stop: stopChild,
      abort: () => preparation?.abort(),
      onStopping: () => {
        quitting = true;
      },
      onStopped: () => app.quit(),
      onFailure: () => {
        quitting = false;
        dialog.showErrorBox("Sacty", t("shutdownFailed"));
      },
    }),
  );
  app.on("window-all-closed", () => app.quit());
}
