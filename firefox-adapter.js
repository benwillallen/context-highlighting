// This adapter provides Firefox-specific implementation for model loading
// since Firefox doesn't support the offscreen API
console.log('Firefox adapter loaded');

// Create a worker for processing
let worker = null;
let activeTabId = null;
let pendingRequests = new Map();
let workerReady = false;

// Initialize the worker
function initializeWorker() {
  console.log('Firefox: Initializing worker');
  
  return new Promise((resolve, reject) => {
    if (worker && workerReady) {
      console.log('Firefox: Worker already exists and is ready');
      resolve(true);
      return;
    }
    
    try {
      console.log('Firefox: Creating new worker');
      
      // If we have an old worker that's not ready, terminate it
      if (worker) {
        console.log('Firefox: Terminating existing non-ready worker');
        worker.terminate();
      }
      
      worker = new Worker('worker.js', { type: 'module' });
      
      // Set timeout for worker initialization
      const initTimeout = setTimeout(() => {
        console.error('Firefox: Worker initialization timed out');
        reject(new Error('Worker initialization timed out'));
      }, 30000); // 30 second timeout
      
      worker.onmessage = function(event) {
        const message = event.data;
        console.log('Firefox: Worker message received:', message);
        
        if (message.action === 'ready') {
          console.log('Firefox: Semantic mapping worker is ready');
          
          // Let worker know we're in Firefox
          console.log('Firefox: Sending initialize with isChromium=false');
          worker.postMessage({ 
            action: 'initialize',
            isChromium: false 
          });
          
          // Mark the worker as ready
          workerReady = true;
          clearTimeout(initTimeout);
          resolve(true);
          
        } else if (message.action === 'topicsExtracted' && message.success) {
          console.log('Firefox: Topics extracted successfully:', message.topics);
          // Find the pending request and resolve it
          const requestId = message.requestId;
          if (pendingRequests.has(requestId)) {
            console.log('Firefox: Resolving pending request:', requestId);
            const { resolve } = pendingRequests.get(requestId);
            resolve(message.topics);
            pendingRequests.delete(requestId);
          }
          
          // Also send to content script if we have an active tab
          if (activeTabId) {
            console.log('Firefox: Sending topics to content script, tab:', activeTabId);
            browser.tabs.sendMessage(activeTabId, {
              action: 'topics-extracted',
              topics: message.topics
            }).catch(err => console.error('Firefox: Error sending to tab:', err));
          }
        } else if (message.action === 'error') {
          console.error('Firefox: Worker error:', message.error);
          // Find the pending request and reject it
          const requestId = message.requestId;
          if (pendingRequests.has(requestId)) {
            console.log('Firefox: Rejecting pending request:', requestId);
            const { reject } = pendingRequests.get(requestId);
            reject(new Error(message.error));
            pendingRequests.delete(requestId);
          }
          
          if (!workerReady) {
            clearTimeout(initTimeout);
            reject(new Error(`Worker initialization failed: ${message.error}`));
          }
        }
      };
      
      worker.onerror = function(error) {
        console.error('Firefox: Worker initialization error:', error);
        clearTimeout(initTimeout);
        reject(error);
      };
      
      console.log('Firefox: Worker event handlers set up');
    } catch (error) {
      console.error('Firefox: Failed to initialize worker:', error);
      reject(error);
    }
  });
}

// Expose methods for the background script
export function initialize() {
  console.log('Firefox: initialize() called');
  return initializeWorker()
    .then(() => {
      console.log('Firefox: Worker initialized successfully');
      return true;
    })
    .catch(error => {
      console.error('Firefox: Worker initialization failed:', error);
      return false;
    });
}

export function extractTopics(tabId, text, topN = 5, options = {}) {
  console.log('Firefox: extractTopics() called', { tabId, textLength: text.length, topN, options });
  
  return new Promise(async (resolve, reject) => {
    if (!worker || !workerReady) {
      console.log('Firefox: Worker not initialized or not ready, initializing now');
      try {
        await initializeWorker();
      } catch (error) {
        console.error('Firefox: Failed to initialize worker for extraction:', error);
        reject(new Error('Failed to initialize worker: ' + error.message));
        return;
      }
    }
    
    // Store the active tab ID for later use
    activeTabId = tabId;
    
    // Create a unique request ID
    const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
    console.log('Firefox: Generated request ID:', requestId);
    
    // Store the promise callbacks for later resolution
    pendingRequests.set(requestId, { resolve, reject });
    
    // Send the request to the worker
    console.log('Firefox: Sending extractTopics to worker');
    worker.postMessage({
      action: 'extractTopics',
      requestId: requestId,
      text: text,
      topN: topN,
      options: options,
      isChromium: false
    });
    console.log('Firefox: Message sent to worker');
  });
}

// Clean up when needed
export function cleanup() {
  console.log('Firefox: cleanup() called');
  if (worker) {
    console.log('Firefox: Terminating worker');
    worker.terminate();
    worker = null;
    workerReady = false;
  }
  pendingRequests.clear();
}