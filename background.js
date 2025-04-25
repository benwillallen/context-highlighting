// background.js - Main controller for the browser extension
console.log('Background script starting');

// Global state management
const state = {
  offscreenDocumentCreated: false,
  isFirefox: false,
  firefoxAdapter: null,
  modelInitialized: false,
  initializationInProgress: false,
  lastInitAttempt: 0,
  offscreenCheckTimer: null,
  activeExtractionPromises: new Map(),
  // Track each request to avoid duplicates
  processingRequests: new Set(),
  // Store iteration state for requests
  iterationStates: new Map()
};

// Detect Firefox vs Chrome
async function detectBrowser() {
  console.log('Detecting browser type');
  
  // Only detect once
  if (state.browserDetected) return;
  
  // Check for Firefox-specific API
  if (typeof browser !== 'undefined' && browser.runtime) {
    console.log('Firefox detected');
    state.isFirefox = true;
    state.browserDetected = true;
    
    // Dynamically import the Firefox adapter (only in Firefox)
    console.log('Importing Firefox adapter');
    try {
      state.firefoxAdapter = await import('./firefox-adapter.js');
      console.log('Firefox adapter loaded successfully');
    } catch (err) {
      console.error('Error loading Firefox adapter:', err);
    }
  } else {
    console.log('Chrome/Chromium detected');
    state.isFirefox = false;
    state.browserDetected = true;
    
    // Check if offscreen document exists using the available API methods
    if (chrome.offscreen) {
      try {
        // Don't use getContexts(), use a safer approach
        await checkOffscreenDocument();
      } catch (e) {
        console.error('Error checking offscreen document:', e);
      }
    }
  }
}

// Check if offscreen document exists
async function checkOffscreenDocument() {
  // The safest approach is to try to create it and catch errors
  try {
    await createOffscreenDocument();
    return true;
  } catch (e) {
    if (e.message && e.message.includes('Only a single offscreen document')) {
      // Document already exists
      console.log('Offscreen document already exists');
      state.offscreenDocumentCreated = true;
      return true;
    }
    console.error('Error checking offscreen document:', e);
    return false;
  }
}

// Create the offscreen document when needed (Chrome only)
async function createOffscreenDocument() {
  console.log('createOffscreenDocument called, current status:', { 
    offscreenDocumentCreated: state.offscreenDocumentCreated, 
    isFirefox: state.isFirefox 
  });
  
  if (state.offscreenDocumentCreated || state.isFirefox) {
    console.log('Skipping offscreen document creation');
    return true;
  }
  
  // Only supported in Chrome MV3
  if (!chrome.offscreen) {
    console.warn("Offscreen API not available");
    return false;
  }
  
  // Check if we're trying to create it too frequently
  const now = Date.now();
  if (now - state.lastInitAttempt < 2000) {
    console.log('Throttling offscreen document creation attempts');
    return false;
  }
  state.lastInitAttempt = now;
  
  try {
    console.log('Creating offscreen document with URL: offscreen.html');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Load ML models for topic extraction'
    });
    console.log('Offscreen document created successfully');
    state.offscreenDocumentCreated = true;
    
    // Wait for the offscreen document to initialize
    console.log('Waiting for offscreen document to initialize');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return true;
  } catch (e) {
    console.error("Error creating offscreen document:", e);
    // If the error is that document already exists, update our state
    if (e.message && e.message.includes('Only a single offscreen document')) {
      state.offscreenDocumentCreated = true;
      return true;
    }
    return false;
  }
}

// Initialize the extension
async function initialize() {
  console.log('initialize called, current state:', { 
    modelInitialized: state.modelInitialized,
    initializationInProgress: state.initializationInProgress 
  });
  
  if (state.modelInitialized) {
    console.log('Models already initialized, skipping');
    return true;
  }
  
  // Prevent concurrent initialization
  if (state.initializationInProgress) {
    console.log('Initialization already in progress, skipping duplicate request');
    return false;
  }
  
  state.initializationInProgress = true;
  
  try {
    await detectBrowser();
    
    if (state.isFirefox) {
      console.log("Firefox environment detected, initializing Firefox adapter");
      if (state.firefoxAdapter) {
        try {
          await state.firefoxAdapter.initialize();
          console.log('Firefox adapter initialized');
          state.modelInitialized = true;
          return true;
        } catch (error) {
          console.error('Error initializing Firefox adapter:', error);
          return false;
        }
      } else {
        console.error('Firefox adapter not available');
        return false;
      }
    } else {
      console.log("Chrome environment detected, creating offscreen document");
      const created = await createOffscreenDocument();
      
      if (created) {
        try {
          // Add a delay to ensure offscreen document is fully loaded
          console.log('Waiting before sending initialize message');
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          console.log('Sending initialize message to offscreen document');
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'initialize',
            isChromium: true
          }).catch(err => {
            // Handle error differently to provide better debug info
            console.warn("Initial message to offscreen failed. This may be expected:", err);
            // Continue anyway as the document might still work
          });
          
          console.log('Offscreen document initialized');
          state.modelInitialized = true;
          return true;
        } catch (err) {
          console.error("Error initializing offscreen document:", err);
          return false;
        }
      } else {
        console.error('Offscreen document not created, cannot initialize models');
        return false;
      }
    }
  } finally {
    state.initializationInProgress = false;
  }
}

// Helper function to generate a unique request ID with sender info
function generateRequestId(sender) {
  const tabInfo = sender?.tab?.id ? `-tab${sender.tab.id}` : '';
  return `extract-${Date.now()}${tabInfo}-${Math.random().toString(36).substring(2, 9)}`;
}

// Helper function to process topic extraction
function processTopicExtraction(message, sender, browserAPI) {
  console.log('Processing topic extraction with sender:', sender);
  const tabId = sender?.tab?.id;
  
  // Generate a unique request ID that includes the tab ID if available
  const requestId = message.requestId || generateRequestId(sender);
  
  // Check if this exact request is already being processed
  const requestKey = `${requestId}-${message.text.substring(0, 50)}`;
  if (state.processingRequests.has(requestKey)) {
    console.log(`Request ${requestKey} already in progress, skipping duplicate`);
    return;
  }
  
  // Mark this request as being processed
  state.processingRequests.add(requestKey);
  
  // Create a promise for this extraction request
  const extractionPromise = extractTopics(message.text, message.topN, message.options || {}, tabId, requestId);
  
  // Store the promise in our active extractions map
  state.activeExtractionPromises.set(requestId, extractionPromise);
  
  extractionPromise
    .then(result => {
      console.log(`Topics extracted successfully for request ${requestId}:`, result);
      
      // Store the iteration state
      state.iterationStates.set(requestId, {
        lastIteration: result.iteration || 0,
        canIterate: result.canIterate !== false,
        requestKey: requestKey,
        tabId: tabId,
        topN: message.topN,
        options: message.options || {}
      });
      
      // Send to both the tab (if from a tab) and the popup
      if (tabId) {
        console.log('Sending topics to tab:', tabId);
        browserAPI.tabs.sendMessage(tabId, {
          action: 'topics-extracted',
          topics: result.topics || result, // Handle both new and old format
          requestId: requestId,
          canIterate: result.canIterate !== false,
          iteration: result.iteration || 0
        }).catch(err => console.error('Error sending topics to tab:', err));
      }
      
      // Always send to popup via runtime messaging (no tab needed)
      console.log('Sending topics to popup via runtime');
      browserAPI.runtime.sendMessage({
        action: 'topics-extracted',
        topics: result.topics || result, // Handle both new and old format
        requestId: requestId,
        canIterate: result.canIterate !== false,
        iteration: result.iteration || 0
      }).catch(err => console.error('Error sending topics to popup:', err));
    })
    .catch(error => {
      console.error(`Topic extraction error for request ${requestId}:`, error);
      notifyError(tabId, error.message || "Failed to extract topics", browserAPI);
    })
    .finally(() => {
      // Clean up the promise from our tracking maps
      state.activeExtractionPromises.delete(requestId);
      state.processingRequests.delete(requestKey);
      // Note: We keep the iterationStates entry for potential future iterations
    });
}

// Helper function to process iteration continuation
function processContinueIteration(message, sender, browserAPI) {
  console.log('Processing continue iteration with sender:', sender);
  const tabId = sender?.tab?.id;
  const requestId = message.requestId;
  
  // Verify we have a stored state for this request
  if (!requestId || !state.iterationStates.has(requestId)) {
    const error = "No previous extraction found to continue iteration";
    console.error(error);
    notifyError(tabId, error, browserAPI);
    return;
  }
  
  const iterationState = state.iterationStates.get(requestId);
  
  // Check if we can continue iterating
  if (!iterationState.canIterate) {
    const error = "No further iterations possible for this extraction";
    console.error(error);
    notifyError(tabId, error, browserAPI);
    return;
  }
  
  // Check if this request is already being processed
  if (state.processingRequests.has(iterationState.requestKey)) {
    console.log(`Request ${iterationState.requestKey} already in progress, skipping duplicate`);
    return;
  }
  
  // Mark this request as being processed
  state.processingRequests.add(iterationState.requestKey);
  
  // Create a promise for this continuation request
  const iterationPromise = continueIteration(
    message.topN || iterationState.topN, 
    message.options || iterationState.options, 
    message.iterationOptions || {}, 
    tabId, 
    requestId
  );
  
  // Store the promise in our active extractions map
  state.activeExtractionPromises.set(requestId, iterationPromise);
  
  iterationPromise
    .then(result => {
      console.log(`Iteration completed successfully for request ${requestId}:`, result);
      
      // Update the iteration state
      state.iterationStates.set(requestId, {
        ...iterationState,
        lastIteration: result.iteration || (iterationState.lastIteration + 1),
        canIterate: result.canIterate !== false
      });
      
      // Send to both the tab (if from a tab) and the popup
      if (tabId) {
        console.log('Sending iteration results to tab:', tabId);
        browserAPI.tabs.sendMessage(tabId, {
          action: 'topics-extracted',
          topics: result.topics || result, // Handle both new and old format
          requestId: requestId,
          canIterate: result.canIterate !== false,
          iteration: result.iteration || (iterationState.lastIteration + 1)
        }).catch(err => console.error('Error sending topics to tab:', err));
      }
      
      // Always send to popup via runtime messaging (no tab needed)
      console.log('Sending iteration results to popup via runtime');
      browserAPI.runtime.sendMessage({
        action: 'topics-extracted',
        topics: result.topics || result, // Handle both new and old format
        requestId: requestId,
        canIterate: result.canIterate !== false,
        iteration: result.iteration || (iterationState.lastIteration + 1)
      }).catch(err => console.error('Error sending iteration results to popup:', err));
    })
    .catch(error => {
      console.error(`Iteration error for request ${requestId}:`, error);
      notifyError(tabId, error.message || "Failed to continue topic extraction iteration", browserAPI);
    })
    .finally(() => {
      // Clean up the promise from our tracking map
      state.activeExtractionPromises.delete(requestId);
      state.processingRequests.delete(iterationState.requestKey);
      // Note: We keep the iterationStates entry for potential future iterations
    });
}

// Helper function to notify about errors
function notifyError(tabId, errorMessage, browserAPI) {
  console.log('Notifying error:', errorMessage);
  
  // Send to tab if we have a tab ID
  if (tabId) {
    console.log('Sending error to tab:', tabId);
    browserAPI.tabs.sendMessage(tabId, {
      action: 'error',
      error: errorMessage
    }).catch(err => console.error('Error sending error to tab:', err));
  }
  
  // Always send to popup via runtime messaging (no tab needed)
  console.log('Sending error to popup via runtime');
  browserAPI.runtime.sendMessage({
    action: 'error',
    error: errorMessage
  }).catch(err => console.error('Error sending error to popup:', err));
}

// Handle messages from content scripts
function setupMessageListener() {
  console.log('Setting up message listeners');
  const browserAPI = state.isFirefox ? browser : chrome;
  
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message, 'from:', sender?.tab?.id || 'extension');
    
    if (message.target === 'background') {
      switch (message.action) {
        case 'extract-topics':
          console.log('Processing extract-topics request', { tabId: sender?.tab?.id });
          
          // Immediately respond to keep the messaging channel open
          sendResponse({ success: true, processing: true });
          
          // Check if initialization was done
          if (!state.modelInitialized) {
            console.log('Models not initialized, initializing now');
            initialize().then(initialized => {
              if (initialized) {
                processTopicExtraction(message, sender, browserAPI);
              } else {
                console.error('Failed to initialize models');
                notifyError(sender?.tab?.id, 'Failed to initialize topic extraction models', browserAPI);
              }
            });
          } else {
            processTopicExtraction(message, sender, browserAPI);
          }
          break;
          
        case 'continue-iteration':
          console.log('Processing continue-iteration request', { 
            tabId: sender?.tab?.id,
            requestId: message.requestId 
          });
          
          // Immediately respond to keep the messaging channel open
          sendResponse({ success: true, processing: true });
          
          // Check if initialization was done
          if (!state.modelInitialized) {
            console.log('Models not initialized, initializing now');
            initialize().then(initialized => {
              if (initialized) {
                processContinueIteration(message, sender, browserAPI);
              } else {
                console.error('Failed to initialize models');
                notifyError(sender?.tab?.id, 'Failed to initialize topic extraction models', browserAPI);
              }
            });
          } else {
            processContinueIteration(message, sender, browserAPI);
          }
          break;
          
        case 'reset-iterations':
          console.log('Processing reset-iterations request', { requestId: message.requestId });
          
          // Reset the iteration state
          if (message.requestId && state.iterationStates.has(message.requestId)) {
            resetIterations(message.requestId, sender?.tab?.id)
              .then(() => {
                // Notify of successful reset
                browserAPI.runtime.sendMessage({
                  action: 'iterations-reset',
                  requestId: message.requestId,
                  success: true
                }).catch(err => console.error('Error notifying of iteration reset:', err));
              })
              .catch(error => {
                console.error('Failed to reset iterations:', error);
                notifyError(sender?.tab?.id, 'Failed to reset iterations', browserAPI);
              });
          } else {
            console.warn('Invalid requestId for reset-iterations:', message.requestId);
            notifyError(sender?.tab?.id, 'Invalid request ID for resetting iterations', browserAPI);
          }
          
          sendResponse({ success: true });
          break;
          
        case 'topics-extracted':
          console.log('Received topics-extracted from offscreen/worker:', 
            message.topics, 
            'iteration:', message.iteration, 
            'canIterate:', message.canIterate
          );
          
          // Only forward topics if we have a request ID that matches
          if (message.requestId && state.activeExtractionPromises.has(message.requestId)) {
            // Handle by active extraction promise
            console.log('RequestId matches an active extraction, will be handled by promise');
          } else {
            // Send to both the tab (if from a tab) and the popup
            if (sender?.tab?.id) {
              console.log('Forwarding topics to tab:', sender.tab.id);
              browserAPI.tabs.sendMessage(sender.tab.id, {
                action: 'topics-extracted',
                topics: message.topics,
                requestId: message.requestId,
                canIterate: message.canIterate !== false,
                iteration: message.iteration || 0
              }).catch(err => console.error('Error forwarding topics to tab:', err));
            }
            
            // Also send to popup
            browserAPI.runtime.sendMessage({
              action: 'topics-extracted',
              topics: message.topics,
              requestId: message.requestId,
              canIterate: message.canIterate !== false,
              iteration: message.iteration || 0
            }).catch(err => console.error('Error forwarding topics to popup:', err));
          }
          
          sendResponse({ success: true });
          break;
        
        case 'iterations-reset':
          console.log('Received iterations-reset from offscreen/worker:', message);
          
          if (message.requestId && state.iterationStates.has(message.requestId)) {
            // Update our stored iteration state
            const iterState = state.iterationStates.get(message.requestId);
            state.iterationStates.set(message.requestId, {
              ...iterState,
              lastIteration: 0,
              canIterate: true
            });
            
            // Forward the reset notification
            browserAPI.runtime.sendMessage({
              action: 'iterations-reset',
              requestId: message.requestId,
              success: true
            }).catch(err => console.error('Error forwarding iteration reset:', err));
          }
          
          sendResponse({ success: true });
          break;
        
        case 'is-firefox':
          console.log('Responding to is-firefox query:', { isFirefox: state.isFirefox });
          sendResponse({ isFirefox: state.isFirefox });
          break;
          
        case 'worker-status':
          // Handle worker ready messages - but don't forward them or process them multiple times
          console.log("Worker status update:", message.status);
          if (message.status === 'ready' && !state.modelInitialized) {
            console.log('Setting modelInitialized to true based on worker ready message');
            state.modelInitialized = true;
          }
          sendResponse({ success: true });
          break;
          
        default:
          console.log('Unknown action:', message.action);
      }
      return true;
    }
  });
}

// Set up browser action click handler
function setupBrowserAction() {
  console.log('Setting up browser action');
  const browserAPI = state.isFirefox ? browser : chrome;
  const actionAPI = state.isFirefox ? browserAPI.browserAction : browserAPI.action;
  
  actionAPI.onClicked.addListener(async (tab) => {
    console.log('Browser action clicked for tab:', tab.id);
    // Initialize on first click if not done already
    if (!state.modelInitialized) {
      console.log('Models not initialized, initializing now');
      await initialize();
    }
    
    // Execute the content script
    console.log('Executing content script in tab:', tab.id);
    if (browserAPI.scripting) {
      await browserAPI.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      console.log('Content script executed via scripting API');
    } else {
      // Fallback for older Firefox versions
      await browserAPI.tabs.executeScript(tab.id, {
        file: "content.js"
      });
      console.log('Content script executed via tabs.executeScript API');
    }
  });
}

// Extract topics using the appropriate method based on browser
async function extractTopics(text, topN = 5, options = {}, tabId, requestId = null) {
  console.log('Extracting topics', { textLength: text.length, topN, options, tabId, requestId });
  
  // Make sure models are initialized
  if (!state.modelInitialized) {
    console.log('Models not initialized, initializing now');
    const initialized = await initialize();
    if (!initialized) {
      throw new Error("Failed to initialize models");
    }
  }
  
  if (state.isFirefox) {
    // Use Firefox adapter
    console.log('Using Firefox adapter for topic extraction');
    if (state.firefoxAdapter) {
      console.log('Calling Firefox adapter extractTopics method');
      try {
        const result = await state.firefoxAdapter.extractTopics(tabId, text, topN, options);
        console.log('Firefox adapter returned topics:', result);
        return {
          topics: result,
          canIterate: true,
          iteration: 0
        };
      } catch (error) {
        console.error('Firefox adapter extraction error:', error);
        throw error;
      }
    } else {
      console.error("Firefox adapter not loaded");
      throw new Error("Firefox adapter not loaded");
    }
  } else if (state.offscreenDocumentCreated) {
    // Use the offscreen document in Chrome
    console.log('Using offscreen document for topic extraction', { requestId });
    return new Promise((resolve, reject) => {
      // Use a unique listener ID for this request to avoid confusion
      const messageListenerId = `listener-${requestId || Date.now().toString()}`;
      
      const messageListener = function(message) {
        // Only log if relevant to this request
        if (message.requestId === requestId || !message.requestId) {
          console.log(`[${messageListenerId}] Got message in background during extraction:`, message);
        }
        
        if (message.target === 'background') {
          if (message.action === 'topics-extracted' && message.requestId === requestId) {
            console.log(`[${messageListenerId}] Topics extracted via offscreen:`, message.topics);
            chrome.runtime.onMessage.removeListener(messageListener);
            resolve({
              topics: message.topics,
              canIterate: message.canIterate !== false,
              iteration: message.iteration || 0
            });
          } else if (message.action === 'error' && message.requestId === requestId) {
            console.error(`[${messageListenerId}] Error from offscreen:`, message.error);
            chrome.runtime.onMessage.removeListener(messageListener);
            reject(new Error(message.error));
          }
          // Ignore other messages that don't match our requestId
        }
      };
      
      console.log(`[${messageListenerId}] Adding temporary message listener for topic extraction`);
      chrome.runtime.onMessage.addListener(messageListener);
      
      console.log(`[${messageListenerId}] Sending extract-topics message to offscreen`);
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'extract-topics',
        text: text,
        topN: topN,
        options: options,
        isChromium: true,
        requestId: requestId
      }).catch(err => {
        console.error(`[${messageListenerId}] Error sending message to offscreen:`, err);
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(err);
      });
      
      // Set a timeout to avoid hanging promises
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(new Error("Topic extraction timed out after 2 minutes"));
      }, 120000);
    });
  } else {
    const error = new Error("No topic extraction method available");
    console.error(error);
    throw error;
  }
}

// Continue topic extraction iteration
async function continueIteration(topN = 5, options = {}, iterationOptions = {}, tabId, requestId) {
  console.log('Continuing topic extraction iteration', { 
    topN, 
    options, 
    iterationOptions, 
    tabId, 
    requestId 
  });
  
  // Make sure models are initialized
  if (!state.modelInitialized) {
    console.log('Models not initialized, initializing now');
    const initialized = await initialize();
    if (!initialized) {
      throw new Error("Failed to initialize models");
    }
  }
  
  if (state.isFirefox) {
    // Use Firefox adapter for iteration (if supported)
    console.log('Using Firefox adapter for topic extraction iteration');
    if (state.firefoxAdapter && state.firefoxAdapter.continueIteration) {
      console.log('Calling Firefox adapter continueIteration method');
      try {
        const result = await state.firefoxAdapter.continueIteration(tabId, topN, options, iterationOptions);
        console.log('Firefox adapter returned topics:', result);
        
        // Determine the iteration number based on stored state
        const iterState = state.iterationStates.get(requestId) || { lastIteration: 0 };
        const iteration = iterState.lastIteration + 1;
        
        return {
          topics: result,
          canIterate: iteration < 5, // Limit Firefox iterations to 5
          iteration: iteration
        };
      } catch (error) {
        console.error('Firefox adapter iteration error:', error);
        throw error;
      }
    } else {
      console.error("Firefox adapter doesn't support iteration");
      throw new Error("Iteration not supported in Firefox");
    }
  } else if (state.offscreenDocumentCreated) {
    // Use the offscreen document in Chrome
    console.log('Using offscreen document for topic extraction iteration', { requestId });
    return new Promise((resolve, reject) => {
      // Use a unique listener ID for this request to avoid confusion
      const messageListenerId = `listener-${requestId || Date.now().toString()}`;
      
      const messageListener = function(message) {
        // Only log if relevant to this request
        if (message.requestId === requestId || !message.requestId) {
          console.log(`[${messageListenerId}] Got message in background during iteration:`, message);
        }
        
        if (message.target === 'background') {
          if (message.action === 'topics-extracted' && message.requestId === requestId) {
            console.log(`[${messageListenerId}] Iteration completed via offscreen:`, message.topics);
            chrome.runtime.onMessage.removeListener(messageListener);
            resolve({
              topics: message.topics,
              canIterate: message.canIterate !== false,
              iteration: message.iteration || 0
            });
          } else if (message.action === 'error' && message.requestId === requestId) {
            console.error(`[${messageListenerId}] Error from offscreen during iteration:`, message.error);
            chrome.runtime.onMessage.removeListener(messageListener);
            reject(new Error(message.error));
          }
          // Ignore other messages that don't match our requestId
        }
      };
      
      console.log(`[${messageListenerId}] Adding temporary message listener for iteration`);
      chrome.runtime.onMessage.addListener(messageListener);
      
      console.log(`[${messageListenerId}] Sending continue-iteration message to offscreen`);
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'continue-iteration',
        topN: topN,
        options: options,
        iterationOptions: iterationOptions,
        isChromium: true,
        requestId: requestId
      }).catch(err => {
        console.error(`[${messageListenerId}] Error sending iteration message to offscreen:`, err);
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(err);
      });
      
      // Set a timeout to avoid hanging promises
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(new Error("Topic extraction iteration timed out after 2 minutes"));
      }, 120000);
    });
  } else {
    const error = new Error("No topic extraction method available");
    console.error(error);
    throw error;
  }
}

// Reset iterations for a specific request
async function resetIterations(requestId, tabId) {
  console.log('Resetting iterations', { requestId, tabId });
  
  // Make sure models are initialized
  if (!state.modelInitialized) {
    console.log('Models not initialized, initializing now');
    const initialized = await initialize();
    if (!initialized) {
      throw new Error("Failed to initialize models");
    }
  }
  
  if (state.isFirefox) {
    // Use Firefox adapter for reset (if supported)
    if (state.firefoxAdapter && state.firefoxAdapter.resetIterations) {
      console.log('Calling Firefox adapter resetIterations method');
      try {
        await state.firefoxAdapter.resetIterations(tabId);
        
        // Update our stored state
        if (state.iterationStates.has(requestId)) {
          const iterState = state.iterationStates.get(requestId);
          state.iterationStates.set(requestId, {
            ...iterState,
            lastIteration: 0,
            canIterate: true
          });
        }
        
        return { success: true };
      } catch (error) {
        console.error('Firefox adapter reset error:', error);
        throw error;
      }
    } else {
      console.log("Firefox adapter doesn't support reset, updating local state only");
      // Just update our local state
      if (state.iterationStates.has(requestId)) {
        const iterState = state.iterationStates.get(requestId);
        state.iterationStates.set(requestId, {
          ...iterState,
          lastIteration: 0,
          canIterate: true
        });
      }
      return { success: true };
    }
  } else if (state.offscreenDocumentCreated) {
    // Use the offscreen document in Chrome
    console.log('Using offscreen document for iteration reset', { requestId });
    return new Promise((resolve, reject) => {
      // Use a unique listener ID for this request to avoid confusion
      const messageListenerId = `reset-${requestId || Date.now().toString()}`;
      
      const messageListener = function(message) {
        if (message.target === 'background') {
          if (message.action === 'iterations-reset' && message.requestId === requestId) {
            console.log(`[${messageListenerId}] Iterations reset via offscreen`);
            chrome.runtime.onMessage.removeListener(messageListener);
            
            // Update our stored state
            if (state.iterationStates.has(requestId)) {
              const iterState = state.iterationStates.get(requestId);
              state.iterationStates.set(requestId, {
                ...iterState,
                lastIteration: 0,
                canIterate: true
              });
            }
            
            resolve({ success: true });
          } else if (message.action === 'error' && message.requestId === requestId) {
            console.error(`[${messageListenerId}] Error from offscreen during reset:`, message.error);
            chrome.runtime.onMessage.removeListener(messageListener);
            reject(new Error(message.error));
          }
          // Ignore other messages that don't match our requestId
        }
      };
      
      console.log(`[${messageListenerId}] Adding temporary message listener for reset`);
      chrome.runtime.onMessage.addListener(messageListener);
      
      console.log(`[${messageListenerId}] Sending reset-iterations message to offscreen`);
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'reset-iterations',
        requestId: requestId
      }).catch(err => {
        console.error(`[${messageListenerId}] Error sending reset message to offscreen:`, err);
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(err);
      });
      
      // Set a timeout to avoid hanging promises
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(new Error("Reset iterations timed out after 30 seconds"));
      }, 30000);
    });
  } else {
    const error = new Error("No topic extraction method available");
    console.error(error);
    throw error;
  }
}

// Start a health check timer for the offscreen document
function startOffscreenHealthChecks() {
  if (state.offscreenCheckTimer) {
    clearInterval(state.offscreenCheckTimer);
  }
  
  state.offscreenCheckTimer = setInterval(async () => {
    if (!state.isFirefox && chrome.offscreen) {
      try {
        // Don't rely on getContexts, just check if need to recreate
        if (!state.offscreenDocumentCreated) {
          console.log('Health check: attempting to recreate offscreen document');
          await createOffscreenDocument();
        }
      } catch (e) {
        console.log('Health check: Error checking offscreen contexts:', e);
      }
    }
  }, 30000); // Check every 30 seconds
}

// Run initialization and setup on extension load
(async function() {
  console.log('Background script self-invoking function started');
  
  // Detect browser first
  await detectBrowser();
  
  // Setup message listeners and browser action
  setupMessageListener();
  setupBrowserAction();
  startOffscreenHealthChecks();
  
  // Initialize when the extension is installed or updated
  const browserAPI = state.isFirefox ? browser : chrome;
  console.log('Setting up onInstalled listener');
  browserAPI.runtime.onInstalled.addListener(details => {
    console.log('Extension installed or updated:', details);
    initialize().then(success => {
      console.log('Model initialization on install finished with status:', success);
    });
  });
  
  // Clean up when the extension is uninstalled or disabled
  if (browserAPI.runtime.onSuspend) {
    browserAPI.runtime.onSuspend.addListener(() => {
      console.log('Extension being suspended');
      
      if (state.offscreenCheckTimer) {
        clearInterval(state.offscreenCheckTimer);
      }
      
      if (state.isFirefox && state.firefoxAdapter) {
        console.log('Cleaning up Firefox adapter');
        state.firefoxAdapter.cleanup();
      }
    });
  }
  
  console.log('Background script initialization complete');
})();