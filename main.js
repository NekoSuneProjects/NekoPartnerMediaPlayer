const { app, BrowserWindow, globalShortcut } = require('electron');

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 700,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.setMenu(null);
    win.loadFile('index.html');
    // Disable Ctrl+R, F5, Ctrl+F5 globally
    globalShortcut.register('CommandOrControl+R', () => { });
    globalShortcut.register('F5', () => { });
    globalShortcut.register('CommandOrControl+Shift+R', () => { });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});