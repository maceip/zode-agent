const electron = require('electron')

// A hidden BrowserWindow alone does not prevent macOS from activating the
// test application and interrupting typing in the user's foreground app.
if (process.platform === 'darwin') electron.app.setActivationPolicy('prohibited')
electron.app.disableHardwareAcceleration()

module.exports = electron
