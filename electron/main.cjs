const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const { testBuild } = require("../package.json");

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
let mainWindow;
let pendingUpdateStatus;

if (testBuild) {
  app.setPath("userData", path.join(app.getPath("appData"), "C_Planner-Teste"));
}

ipcMain.handle("app:get-version", () => app.getVersion());

ipcMain.handle("app:export-pdf", async (_event, { html, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Exportar projeto em PDF",
    defaultPath: path.join(app.getPath("documents"), defaultName),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const printWindow = new BrowserWindow({ show: false });
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await printWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true });
    await fs.writeFile(filePath, pdf);
    return { canceled: false, filePath };
  } finally {
    printWindow.destroy();
  }
});

function sendUpdateStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingUpdateStatus = message;
    return;
  }
  mainWindow.webContents.send("app:update-status", message);
}

async function backupUserData() {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("A janela do aplicativo não está disponível.");

  const storage = await mainWindow.webContents.executeJavaScript("window.cPlanner.getStorageSnapshot()");
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    throw new Error("Não foi possível ler os dados locais do aplicativo.");
  }

  const backupDirectory = path.join(app.getPath("userData"), "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(backupDirectory, `backup-pre-atualizacao-${timestamp}.json`);
  const temporaryPath = `${backupPath}.tmp`;
  const contents = JSON.stringify({
    formatVersion: 1,
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    storage,
  }, null, 2);

  await fs.writeFile(temporaryPath, contents, "utf8");
  await fs.rename(temporaryPath, backupPath);
}

function configureAutoUpdater() {
  if (!app.isPackaged || testBuild || devServerUrl) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => sendUpdateStatus("Verificando atualizações…"));
  autoUpdater.on("update-available", ({ version }) => sendUpdateStatus(`Nova versão ${version} encontrada. Baixando…`));
  autoUpdater.on("update-not-available", () => sendUpdateStatus(`C_Planner ${app.getVersion()} está atualizado.`));
  autoUpdater.on("error", (error) => {
    console.error("Falha na atualização do C_Planner:", error);
    sendUpdateStatus("Não foi possível verificar ou baixar atualizações. O C_Planner continuará funcionando normalmente.");
  });
  autoUpdater.on("update-downloaded", async ({ version }) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Atualização pronta",
      message: `A versão ${version} foi baixada. Reinicie o C_Planner para instalá-la.`,
      buttons: ["Reiniciar agora", "Depois"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return;

    try {
      await backupUserData();
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      console.error("Falha ao criar backup antes da atualização:", error);
      await dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Atualização não instalada",
        message: "Não foi possível criar o backup dos dados. O C_Planner continuará nesta versão e seus dados foram mantidos.",
        buttons: ["OK"],
      });
    }
  });

  autoUpdater.checkForUpdates().catch((error) => {
    console.error("Falha ao verificar atualizações do C_Planner:", error);
    sendUpdateStatus("Não foi possível verificar atualizações. O C_Planner continuará funcionando normalmente.");
  });
}

ipcMain.handle("app:check-updates", async () => {
  if (!app.isPackaged || testBuild || devServerUrl) {
    sendUpdateStatus("A busca de atualizações só funciona no aplicativo instalado.");
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error("Falha ao verificar atualizações do C_Planner:", error);
    sendUpdateStatus("Não foi possível verificar atualizações. O C_Planner continuará funcionando normalmente.");
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#f3f5f1",
    icon: path.join(__dirname, "..", "assets", "c-planner.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
    mainWindow = window;
    window.webContents.on("did-finish-load", () => {
      if (pendingUpdateStatus) {
        window.webContents.send("app:update-status", pendingUpdateStatus);
        pendingUpdateStatus = undefined;
      }
    });
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = undefined;
    });

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  configureAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});