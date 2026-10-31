const start = document.getElementById("start");
const save = document.getElementById("save");
const key = document.getElementById("key");
const language = document.getElementById("language");
const status = document.getElementById("status");
const diagnosticPanel = document.getElementById("diagnostics");
const diagnosticOutput = document.getElementById("diagnostic-output");
const keyStatus = document.getElementById("key-status");
let messages;
function render(settings) {
  messages = settings.messages;
  document.documentElement.lang = settings.locale;
  document.title = messages.title;
  language.value = settings.locale;
  document.querySelector("main").hidden = false;
  for (const element of document.querySelectorAll("[data-i18n]"))
    element.textContent = messages[element.dataset.i18n];
  for (const element of document.querySelectorAll("[data-i18n-aria]"))
    element.setAttribute("aria-label", messages[element.dataset.i18nAria]);
  status.textContent = messages.ready;
  keyStatus.textContent = "";
}
window.desktop.settings().then((settings) => {
  render(settings);
  start.disabled = false;
  save.disabled = false;
});
language.addEventListener("change", async () => {
  language.disabled = true;
  try {
    render(await window.desktop.language(language.value));
  } catch {
    language.value = document.documentElement.lang;
    status.textContent = messages.invalidOperation;
  } finally {
    language.disabled = false;
  }
});
window.desktop.onProgress((message) => {
  status.textContent = message;
});
start.addEventListener("click", async () => {
  diagnosticPanel.hidden = true;
  diagnosticPanel.open = false;
  diagnosticOutput.textContent = "";
  start.disabled = true;
  language.disabled = true;
  try {
    const result = await window.desktop.start();
    if (!result.ok) {
      status.textContent = result.message;
      diagnosticOutput.textContent = result.diagnostics || "";
      diagnosticPanel.hidden = !result.diagnostics;
    }
  } catch {
    status.textContent = messages.startFailed;
  } finally {
    start.disabled = false;
    language.disabled = false;
  }
});
save.addEventListener("click", async () => {
  save.disabled = true;
  const value = key.value;
  key.value = "";
  try {
    const result = await window.desktop.saveKey(value);
    keyStatus.textContent = result.ok ? messages.keySaved : result.message;
  } catch {
    keyStatus.textContent = messages.keyFailed;
  } finally {
    save.disabled = false;
  }
});
document.getElementById("help").addEventListener("click", () => window.desktop.help());
for (const button of document.querySelectorAll(".hint")) {
  const tooltip = document.getElementById(button.getAttribute("aria-describedby"));
  const show = () => {
    tooltip.hidden = false;
  };
  const hide = () => {
    tooltip.hidden = true;
  };
  button.addEventListener("pointerenter", show);
  button.addEventListener("pointerleave", () => {
    if (document.activeElement !== button) hide();
  });
  button.addEventListener("focus", show);
  button.addEventListener("blur", hide);
  button.addEventListener("click", () => {
    tooltip.hidden = !tooltip.hidden;
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
      button.blur();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!button.parentElement.contains(event.target)) hide();
  });
}
