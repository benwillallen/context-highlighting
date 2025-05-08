// Initialization script for offscreen document
// Capture console logs for debugging
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const logs = [];

console.log = function(...args) {
  logs.push(['log', ...args]);
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  logs.push(['error', ...args]);
  originalConsoleError.apply(console, args);
};

// Initialize registry to track kernels
window._tfKernelRegistry = new Map();
console.log('Kernel registry initialized in offscreen document');

// Helper to export logs
window.getLogs = function() {
  return logs;
};

// Add a heartbeat to notify background we're alive
window.addEventListener('load', function() {
  console.log('Offscreen document loaded');
  
  // Send a heartbeat to the background script
  if (chrome.runtime) {
    try {
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'offscreen-loaded'
      });
      console.log('Initial heartbeat sent to background');
    } catch (e) {
      console.warn('Failed to send heartbeat:', e);
    }
  }
});
