console.log('Offscreen script loaded');

// Import TensorFlow.js
import * as tf from '@tensorflow/tfjs';
// Import our utility before any other TF operations
import { initializeTensorFlow, getRegisteredKernelCount } from './tf-init.js';

// Add this right after imports to signal document is loaded
console.log('Sending offscreen-loaded notification to background');
try {
  chrome.runtime.sendMessage({
    target: 'background',
    action: 'offscreen-loaded',
    status: 'ready'
  }).catch(err => console.warn('Non-critical error notifying background of offscreen load:', err));
} catch (err) {
  console.warn('Unable to send initial ready message, may not be an issue:', err);
}

// Apply the patch immediately
initializeTensorFlow(tf, 'offscreen');

console.log('TensorFlow.js imported and patched in offscreen:', tf.version);
console.log('Registered kernels:', getRegisteredKernelCount());

// Add flag to track TensorFlow initialization
let tfInitialized = false;

// Initialize backend for TensorFlow.js
function initializeBackend() {
  if (tfInitialized) {
    console.log('TensorFlow backend already initialized in offscreen, skipping');
    return Promise.resolve();
  }
  
  console.log('Initializing TensorFlow backend in offscreen document');
  
  // Initialize the backend
  return tf.ready().then(() => {
    console.log('TensorFlow backend ready in offscreen:', tf.getBackend());
    tfInitialized = true;
  });
}

// Initialize TensorFlow immediately
initializeBackend();

// Create a worker for processing
let worker = null;
let pendingRequests = new Map();
let workerInitialized = false;
let workerInitializing = false;
let readyMessageSent = false; // Track if we've sent a ready message

// Handle messages from the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message, 'from:', sender);
  if (message.target !== 'offscreen') {
    console.log('Message not targeted for offscreen, ignoring');
    return;
  }

  switch (message.action) {
    case 'initialize':
      console.log('Initializing worker with isChromium:', message.isChromium);
      // Check if already initialized with the same setting
      if (workerInitialized && worker) {
        console.log('Worker already initialized, sending success response');
        sendResponse({ success: true });
        return true;
      }
      
      initializeWorker(message.isChromium)
        .then(() => {
          console.log('Worker initialization complete');
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('Worker initialization failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep message channel open for async response
      
    case 'extract-topics':
      console.log('Extract topics requested for text length:', message.text.length, 'requestId:', message.requestId);
      extractTopics(message.text, message.topN, message.options, message.isChromium, message.requestId)
        .then(results => {
          console.log('Topic extraction successful, sending results to background:', results);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'topics-extracted',
            topics: results,
            requestId: message.requestId,
            canIterate: true,
            iteration: 0
          });
        })
        .catch(error => {
          console.error('Topic extraction failed:', error);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'error',
            error: error.message,
            requestId: message.requestId
          });
        });
      sendResponse({ success: true });
      return false;
    
    case 'continue-iteration':
      console.log('Continue iteration requested for requestId:', message.requestId);
      continueIteration(message.topN, message.options, message.iterationOptions, message.isChromium, message.requestId)
        .then(results => {
          console.log('Iteration extraction successful, sending results to background:', results);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'topics-extracted',
            topics: results.topics,
            requestId: message.requestId,
            canIterate: results.canIterate,
            iteration: results.iteration
          });
        })
        .catch(error => {
          console.error('Iteration extraction failed:', error);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'error',
            error: error.message,
            requestId: message.requestId
          });
        });
      sendResponse({ success: true });
      return false;
      
    case 'reset-iterations':
      console.log('Reset iterations requested');
      resetIterations(message.requestId)
        .then(result => {
          console.log('Iterations reset:', result);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'iterations-reset',
            requestId: message.requestId,
            success: true
          });
        })
        .catch(error => {
          console.error('Reset iterations failed:', error);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'error',
            error: error.message,
            requestId: message.requestId
          });
        });
      sendResponse({ success: true });
      return false;
    
    case 'set-max-iterations':
      console.log('Set max iterations requested:', message.maxIterations);
      setMaxIterations(message.maxIterations, message.requestId)
        .then(result => {
          console.log('Max iterations set:', result);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'max-iterations-set',
            maxIterations: result.maxIterations,
            requestId: message.requestId,
            success: true
          });
        })
        .catch(error => {
          console.error('Set max iterations failed:', error);
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'error',
            error: error.message,
            requestId: message.requestId
          });
        });
      sendResponse({ success: true });
      return false;
      
    default:
      console.log('Unknown action:', message.action);
  }
});

// Initialize the worker
async function initializeWorker(isChromium = true) {
  console.log('initializeWorker called, current state:', { 
    workerExists: !!worker, 
    workerInitialized, 
    workerInitializing,
    isChromium,
    readyMessageSent
  });
  
  // Return immediately if already initialized
  if (workerInitialized && worker) {
    console.log('Worker already initialized, skipping');
    return;
  }
  
  // Return a promise if initialization is in progress
  if (workerInitializing) {
    console.log('Worker initialization in progress, waiting...');
    return new Promise((resolve, reject) => {
      const checkInitialized = () => {
        if (workerInitialized) {
          resolve();
        } else if (!workerInitializing) {
          reject(new Error("Worker initialization failed"));
        } else {
          setTimeout(checkInitialized, 100);
        }
      };
      
      setTimeout(checkInitialized, 100);
    });
  }
  
  workerInitializing = true;
  
  try {
    console.log('Creating new Worker with module type');
    
    // Cleanup existing worker if any
    if (worker) {
      console.log('Terminating existing worker');
      worker.terminate();
      worker = null;
    }
    
    worker = new Worker('worker.js', { type: 'module' });
    
    // Wait for the worker to be ready
    await new Promise((resolve, reject) => {
      console.log('Setting up worker message handler for initialization');
      
      const initTimeout = setTimeout(() => {
        console.error('Worker initialization timed out');
        reject(new Error('Worker initialization timed out after 30 seconds'));
      }, 30000);
      
      const messageHandler = function(event) {
        const message = event.data;
        console.log('Worker sent message during initialization:', message);
        
        if (message.action === 'ready') {
          console.log('Worker is ready, completing initialization');
          clearTimeout(initTimeout);
          worker.removeEventListener('message', messageHandler);
          
          // Set up the permanent message handler
          setupWorkerMessageHandler();
          
          // Send initialize message to the worker
          console.log('Sending initialize message to worker with isChromium:', isChromium);
          worker.postMessage({ 
            action: 'initialize', 
            isChromium: isChromium 
          });
          
          // Only notify background script once per offscreen document session
          if (!readyMessageSent) {
            console.log('Sending worker-ready notification to background');
            chrome.runtime.sendMessage({
              target: 'background',
              action: 'worker-status',
              status: 'ready'
            }).catch(err => console.error('Error notifying background of worker ready:', err));
            readyMessageSent = true;
          } else {
            console.log('Ready message already sent, skipping notification');
          }
          
          workerInitialized = true;
          workerInitializing = false;
          resolve();
        }
      };
      
      worker.addEventListener('message', messageHandler);
      
      worker.onerror = function(error) {
        console.error('Worker setup error:', error);
        clearTimeout(initTimeout);
        workerInitializing = false;
        reject(new Error('Failed to initialize worker: ' + error.message));
      };
    });
    
    console.log('Worker initialization complete');
  } catch (error) {
    console.error('Failed to initialize worker:', error);
    workerInitializing = false;
    throw error;
  }
}

// Set up the permanent worker message handler
function setupWorkerMessageHandler() {
  console.log('Setting up permanent worker message handler');
  
  worker.onmessage = function(event) {
    const message = event.data;
    console.log('Worker sent message:', message);
    
    if (message.action === 'topicsExtracted' && message.success) {
      console.log('Worker extracted topics successfully:', message.topics);
      const requestId = message.requestId;
      
      if (pendingRequests.has(requestId)) {
        console.log('Found pending request for ID:', requestId);
        const { resolve } = pendingRequests.get(requestId);
        resolve({
          topics: message.topics,
          iteration: message.iteration,
          canIterate: message.canIterate
        });
        pendingRequests.delete(requestId);
        console.log('Resolved pending request and removed from map');
      } else {
        console.warn('Received topics for unknown request ID:', requestId);
      }
    } else if (message.action === 'iterationComplete' || message.action === 'iterationReset' || message.action === 'maxIterationsSet') {
      console.log(`Received ${message.action} notification:`, message);
      const requestId = message.requestId;
      
      if (pendingRequests.has(requestId)) {
        console.log(`Found pending request for ${message.action} ID:`, requestId);
        const { resolve } = pendingRequests.get(requestId);
        resolve(message);
        pendingRequests.delete(requestId);
        console.log('Resolved pending request and removed from map');
      } else {
        console.warn(`Received ${message.action} for unknown request ID:`, requestId);
      }
    } else if (message.action === 'error') {
      console.error('Worker error:', message.error);
      const requestId = message.requestId;
      
      if (pendingRequests.has(requestId)) {
        console.log('Found pending request for error ID:', requestId);
        const { reject } = pendingRequests.get(requestId);
        reject(new Error(message.error));
        pendingRequests.delete(requestId);
        console.log('Rejected pending request and removed from map');
      } else {
        console.warn('Received error for unknown request ID:', requestId);
      }
    }
  };
  
  worker.onerror = function(error) {
    console.error('Worker runtime error:', error);
    
    // Notify all pending requests of the error
    pendingRequests.forEach(({ reject }, id) => {
      console.log('Rejecting pending request due to worker error:', id);
      reject(new Error('Worker encountered an error: ' + error.message));
    });
    
    pendingRequests.clear();
  };
}

// Extract topics using the worker
async function extractTopics(text, topN = 5, options = {}, isChromium = true, requestId = null) {
  console.log('extractTopics called with:', { 
    textLength: text.length, 
    topN, 
    options, 
    isChromium,
    requestId 
  });
  
  // Make sure worker is initialized
  if (!workerInitialized || !worker) {
    console.log('Worker not initialized, initializing now');
    await initializeWorker(isChromium);
  }
  
  return new Promise((resolve, reject) => {
    // Use provided requestId or generate one
    const id = requestId || Date.now().toString() + Math.random().toString(36).substring(2);
    console.log('Using request ID:', id);
    
    // Store the promise callbacks for later resolution
    console.log('Storing promise callbacks for later resolution');
    pendingRequests.set(id, { resolve, reject });
    
    // Set a timeout to avoid hanging promises
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        console.error(`Request ${id} timed out after 2 minutes`);
        reject(new Error('Topic extraction timed out after 2 minutes'));
        pendingRequests.delete(id);
      }
    }, 120000);
    
    // Send the request to the worker
    console.log('Sending extractTopics request to worker');
    worker.postMessage({
      action: 'extractTopics',
      requestId: id,
      text: text,
      topN: topN,
      options: options,
      isChromium: isChromium
    });
    console.log('Request sent to worker');
    
    // Update the stored promise to include timeout cleanup
    pendingRequests.set(id, { 
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      }, 
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

// Continue iteration of topic extraction using the worker
async function continueIteration(topN = 5, options = {}, iterationOptions = {}, isChromium = true, requestId = null) {
  console.log('continueIteration called with:', { 
    topN, 
    options,
    iterationOptions,
    isChromium,
    requestId 
  });
  
  // Make sure worker is initialized
  if (!workerInitialized || !worker) {
    console.log('Worker not initialized, initializing now');
    await initializeWorker(isChromium);
  }
  
  return new Promise((resolve, reject) => {
    // Use provided requestId or generate one
    const id = requestId || Date.now().toString() + Math.random().toString(36).substring(2);
    console.log('Using request ID:', id);
    
    // Store the promise callbacks for later resolution
    console.log('Storing promise callbacks for later resolution');
    pendingRequests.set(id, { resolve, reject });
    
    // Set a timeout to avoid hanging promises
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        console.error(`Request ${id} timed out after 2 minutes`);
        reject(new Error('Topic extraction iteration timed out after 2 minutes'));
        pendingRequests.delete(id);
      }
    }, 120000);
    
    // Send the request to the worker
    console.log('Sending continueIteration request to worker');
    worker.postMessage({
      action: 'continueIteration',
      requestId: id,
      topN: topN,
      options: options,
      iterationOptions: iterationOptions,
      isChromium: isChromium
    });
    console.log('Request sent to worker');
    
    // Update the stored promise to include timeout cleanup
    pendingRequests.set(id, { 
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      }, 
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

// Reset iteration counter
async function resetIterations(requestId = null) {
  console.log('resetIterations called with requestId:', requestId);
  
  // Make sure worker is initialized
  if (!workerInitialized || !worker) {
    console.log('Worker not initialized, cannot reset iterations');
    throw new Error('Worker not initialized');
  }
  
  return new Promise((resolve, reject) => {
    // Use provided requestId or generate one
    const id = requestId || Date.now().toString() + Math.random().toString(36).substring(2);
    console.log('Using request ID:', id);
    
    // Store the promise callbacks for later resolution
    console.log('Storing promise callbacks for later resolution');
    pendingRequests.set(id, { resolve, reject });
    
    // Set a timeout to avoid hanging promises
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        console.error(`Request ${id} timed out after 30 seconds`);
        reject(new Error('Reset iterations timed out after 30 seconds'));
        pendingRequests.delete(id);
      }
    }, 30000);
    
    // Send the request to the worker
    console.log('Sending resetIterations request to worker');
    worker.postMessage({
      action: 'resetIterations',
      requestId: id
    });
    console.log('Request sent to worker');
    
    // Update the stored promise to include timeout cleanup
    pendingRequests.set(id, { 
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      }, 
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

// Set maximum number of iterations
async function setMaxIterations(maxIterations, requestId = null) {
  console.log('setMaxIterations called with:', { maxIterations, requestId });
  
  // Make sure worker is initialized
  if (!workerInitialized || !worker) {
    console.log('Worker not initialized, cannot set max iterations');
    throw new Error('Worker not initialized');
  }
  
  return new Promise((resolve, reject) => {
    // Use provided requestId or generate one
    const id = requestId || Date.now().toString() + Math.random().toString(36).substring(2);
    console.log('Using request ID:', id);
    
    // Store the promise callbacks for later resolution
    console.log('Storing promise callbacks for later resolution');
    pendingRequests.set(id, { resolve, reject });
    
    // Set a timeout to avoid hanging promises
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        console.error(`Request ${id} timed out after 30 seconds`);
        reject(new Error('Set max iterations timed out after 30 seconds'));
        pendingRequests.delete(id);
      }
    }, 30000);
    
    // Send the request to the worker
    console.log('Sending setMaxIterations request to worker');
    worker.postMessage({
      action: 'setMaxIterations',
      maxIterations: maxIterations,
      requestId: id
    });
    console.log('Request sent to worker');
    
    // Update the stored promise to include timeout cleanup
    pendingRequests.set(id, { 
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      }, 
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

// Make sure we clean up when the document is unloaded
window.addEventListener('unload', () => {
  console.log('Offscreen document unloading, cleaning up');
  if (worker) {
    console.log('Terminating worker');
    worker.terminate();
    worker = null;
  }
  pendingRequests.clear();
  console.log('Cleanup complete');
});