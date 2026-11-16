// Test helper for tests/contract/permission-warning-diff.js. Never shipped.
// chrome.management.getPermissionWarningsByManifest needs no permission of
// its own. The test calls self.warningsFor from the worker.
self.warningsFor = (manifestText) =>
  new Promise((resolve, reject) => {
    chrome.management.getPermissionWarningsByManifest(manifestText, (warnings) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(warnings);
    });
  });
