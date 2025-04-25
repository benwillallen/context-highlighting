// Context Highlighter Popup Script
document.addEventListener('DOMContentLoaded', function() {
  console.log('Popup initialized');
  
  // Get UI elements
  const extractButton = document.getElementById('extract-topics');
  const tfidfButton = document.getElementById('highlight-tfidf');
  const statusText = document.getElementById('status-text');
  const topicsContainer = document.getElementById('topics-container');
  const useTfidfCheck = document.getElementById('use-tfidf');
  const useMlCheck = document.getElementById('use-ml');
  
  // Check which browser we're running on
  const isFirefox = typeof browser !== 'undefined';
  const browserAPI = isFirefox ? browser : chrome;
  console.log('Browser detected:', isFirefox ? 'Firefox' : 'Chrome');
  
  // Storage API compatible with both browsers
  const storage = isFirefox 
    ? browserAPI.storage.local
    : browserAPI.storage.session || browserAPI.storage.local;
  
  // Initialize the UI from stored state
  initializeFromStorage();
  
  // Function to send message to background script
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      console.log('Sending message from popup:', message);
      browserAPI.runtime.sendMessage(message, response => {
        const error = browserAPI.runtime.lastError;
        if (error) {
          console.error('Runtime error when sending message:', error);
          reject(error);
        } else {
          console.log('Received response for message:', response);
          resolve(response);
        }
      });
    });
  }
  
  // Load state from storage
  async function initializeFromStorage() {
    try {
      console.log('Loading state from storage');
      
      // Get the active tab to use as key for storage
      const tabs = await browserAPI.tabs.query({active: true, currentWindow: true});
      if (!tabs || tabs.length === 0) {
        console.log('No active tab found for state restoration');
        return;
      }
      
      const tabId = tabs[0].id.toString();
      const storageKey = `topics_${tabId}`;
      
      storage.get([storageKey, 'options'], result => {
        console.log('Retrieved from storage:', result);
        
        // Restore options if they exist
        if (result.options) {
          if (useTfidfCheck) {
            useTfidfCheck.checked = !!result.options.useTfidf;
          }
          if (useMlCheck) {
            useMlCheck.checked = result.options.useMl !== false; // Default to true
          }
        }
        
        // Restore topics if they exist
        const savedTopics = result[storageKey];
        if (savedTopics && savedTopics.topics && savedTopics.topics.length > 0) {
          console.log('Restoring topics from storage:', savedTopics.topics);
          displayTopics(savedTopics.topics);
          
          // If we have topics, also restore status
          if (statusText) {
            statusText.textContent = savedTopics.status || 'Done!';
          }
        }
      });
    } catch (err) {
      console.error('Error loading state from storage:', err);
    }
  }
  
  // Save state to storage
  function saveStateToStorage(topics, status) {
    browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
      if (!tabs || tabs.length === 0) {
        console.log('No active tab found for state saving');
        return;
      }
      
      const tabId = tabs[0].id.toString();
      const storageKey = `topics_${tabId}`;
      
      const options = {
        useTfidf: useTfidfCheck?.checked || false,
        useMl: useMlCheck?.checked !== false
      };
      
      const stateObj = {};
      stateObj[storageKey] = { topics, status };
      stateObj['options'] = options;
      
      console.log('Saving state to storage:', stateObj);
      storage.set(stateObj);
    });
  }
  
  // Handle quick TF-IDF highlight button click
  if (tfidfButton) {
    tfidfButton.addEventListener('click', async () => {
      console.log('TF-IDF highlight button clicked');
      statusText.textContent = 'Highlighting important sentences...';
      
      try {
        // Get active tab
        const tabs = await browserAPI.tabs.query({active: true, currentWindow: true});
        if (tabs.length === 0) {
          console.error('No active tab found');
          statusText.textContent = 'Error: No active tab found';
          return;
        }
        
        const activeTab = tabs[0];
        console.log('Active tab:', activeTab.id, activeTab.url);
        
        // Send message to content script to perform TF-IDF highlighting
        console.log('Sending highlight-tfidf message to content script');
        
        browserAPI.tabs.sendMessage(
          activeTab.id, 
          { action: 'highlight-tfidf' },
          response => {
            const error = browserAPI.runtime.lastError;
            if (error) {
              console.error('Error highlighting with TF-IDF:', error);
              statusText.textContent = 'Error: Could not highlight sentences';
            } else {
              console.log('TF-IDF highlighting completed:', response);
              statusText.textContent = 'Important sentences highlighted!';
              
              // Save the status
              saveStateToStorage([], 'Important sentences highlighted!');
            }
          }
        );
      } catch (error) {
        console.error('Error during TF-IDF highlighting:', error);
        statusText.textContent = 'Error: ' + error.message;
        saveStateToStorage([], 'Error: ' + error.message);
      }
    });
  }
  
  // Handle ML topic extraction button click
  if (extractButton) {
    extractButton.addEventListener('click', async () => {
      console.log('Extract button clicked');
      statusText.textContent = 'Extracting topics...';
      saveStateToStorage([], 'Extracting topics...');
      
      try {
        // Get active tab
        const tabs = await browserAPI.tabs.query({active: true, currentWindow: true});
        const activeTab = tabs[0];
        console.log('Active tab:', activeTab.id, activeTab.url);
        
        // Send message to content script to extract text from page
        console.log('Requesting text extraction from content script');
        try {
          const textExtractionPromise = new Promise((resolve, reject) => {
            browserAPI.tabs.sendMessage(
              activeTab.id, 
              { action: 'extract-page-text' },
              response => {
                const error = browserAPI.runtime.lastError;
                if (error) {
                  console.error('Error getting text from content script:', error);
                  reject(error);
                } else if (!response) {
                  console.error('No response from content script');
                  reject(new Error('No response from content script'));
                } else {
                  console.log('Received content script response:', response);
                  resolve(response);
                }
              }
            );
          });
          
          const response = await textExtractionPromise;
          
          if (response && response.text) {
            // Send text to background for processing
            const options = {
              useTfidf: useTfidfCheck?.checked || false,
              useMl: useMlCheck?.checked || true
            };
            console.log('Sending text to background script with options:', options);
            saveStateToStorage([], 'Processing...');
            
            try {
              await sendMessage({
                target: 'background',
                action: 'extract-topics',
                text: response.text,
                topN: 5,
                options: options
              });
              
              console.log('Background processing request acknowledged');
              statusText.textContent = 'Processing...';
            } catch (error) {
              console.error('Error sending to background script:', error);
              statusText.textContent = 'Error: Could not send to background script';
              saveStateToStorage([], 'Error: Could not send to background script');
            }
          } else {
            console.error('Invalid response from content script');
            statusText.textContent = 'Error: Invalid response from content script';
            saveStateToStorage([], 'Error: Invalid response from content script');
          }
        } catch (error) {
          console.error('Error communicating with content script:', error);
          statusText.textContent = 'Error: Could not extract page content';
          saveStateToStorage([], 'Error: Could not extract page content');
        }
      } catch (error) {
        console.error('General error during extraction:', error);
        statusText.textContent = 'Error: ' + error.message;
        saveStateToStorage([], 'Error: ' + error.message);
      }
    });
  }
  
  // Listen for topic extraction completion
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Popup received message:', message);
    if (message.action === 'topics-extracted') {
      console.log('Topics extracted:', message.topics);
      displayTopics(message.topics);
      statusText.textContent = 'Done!';
      
      // Save the topics and status
      saveStateToStorage(message.topics, 'Done!');
      
      sendResponse({received: true});
    } else if (message.action === 'error') {
      console.error('Error received in popup:', message.error);
      statusText.textContent = `Error: ${message.error}`;
      
      // Save the error status
      saveStateToStorage([], `Error: ${message.error}`);
      
      sendResponse({received: true});
    }
    return true;
  });
  
  // Save option changes
  if (useTfidfCheck) {
    useTfidfCheck.addEventListener('change', () => {
      console.log('Use TF-IDF option changed:', useTfidfCheck.checked);
      saveStateToStorage([], statusText.textContent);
    });
  }
  
  if (useMlCheck) {
    useMlCheck.addEventListener('change', () => {
      console.log('Use ML option changed:', useMlCheck.checked);
      saveStateToStorage([], statusText.textContent);
    });
  }
  
  // Display topics in the popup
  function displayTopics(topics) {
    console.log('Displaying topics in popup');
    if (!topicsContainer) return;
    
    topicsContainer.innerHTML = '';
    
    if (topics && topics.length > 0) {
      const list = document.createElement('ul');
      
      topics.forEach(topic => {
        const item = document.createElement('li');
        const score = Math.round(topic.relevanceScore * 100);
        item.textContent = `${topic.topic} (${score}%)`;
        
        // Add categories as tags
        if (topic.subcategories && topic.subcategories.length > 0) {
          const tags = document.createElement('div');
          tags.className = 'tags';
          
          topic.subcategories.forEach(category => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = category;
            tags.appendChild(tag);
          });
          
          item.appendChild(tags);
        }
        
        list.appendChild(item);
      });
      
      topicsContainer.appendChild(list);
    } else {
      topicsContainer.textContent = 'No topics found.';
    }
  }
});
