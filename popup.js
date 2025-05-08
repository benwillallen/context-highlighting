document.addEventListener("DOMContentLoaded", () => {
  const highlightBtn = document.getElementById("highlight");
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  
  // Update button state based on current content script state
  function updateButtonState(tab) {
    // Check the current state of the content script
    browserAPI.tabs.sendMessage(
      tab.id, 
      { action: 'get-state' }, 
      response => {
        if (browserAPI.runtime.lastError) {
          // Content script probably not loaded yet
          highlightBtn.textContent = "Highlight Important Sentences";
          highlightBtn.disabled = false;
          return;
        }
        
        // Update button based on state
        if (response && response.state) {
          const state = response.state;
          if (state.tfidfHighlighted && state.topicsRequested) {
            highlightBtn.textContent = "Already Highlighted";
            highlightBtn.disabled = true;
          } else {
            highlightBtn.textContent = "Highlight Important Sentences";
            highlightBtn.disabled = false;
          }
        }
      }
    );
  }
  
  // When popup opens, get current tab and update button state
  browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs.length > 0) {
      const activeTab = tabs[0];
      updateButtonState(activeTab);
    }
  });
  
  // Function to ensure content script is injected and ready
  async function ensureContentScript(tabId) {
    console.log(`Ensuring content script is ready in tab ${tabId}`);
    try {
        // Attempt to send a ping message. If it fails, the script needs injection.
        await browserAPI.tabs.sendMessage(tabId, { target: 'content', action: 'ping' });
        console.log('Content script already loaded and responded to ping.');
        return true; // Script is ready
    } catch (error) {
        // Ping failed, likely because the script isn't loaded or listening yet.
        console.log('Content script ping failed, attempting injection...');
        try {
            await browserAPI.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js'] // Make sure this path is correct
            });
            console.log('Content script injected. Waiting briefly for initialization...');
            // Wait a short period to allow the script to initialize its listener.
            // This isn't foolproof but often sufficient for simple scripts.
            await new Promise(resolve => setTimeout(resolve, 150)); // 150ms delay
            // Optionally, try pinging again after injection to be more certain
            try {
                 await browserAPI.tabs.sendMessage(tabId, { target: 'content', action: 'ping' });
                 console.log('Content script responded to ping after injection.');
                 return true;
            } catch (pingError) {
                 console.error('Content script did not respond to ping even after injection:', pingError);
                 return false; // Still not ready
            }
        } catch (injectionError) {
            console.error('Failed to inject content script:', injectionError);
            return false; // Injection failed
        }
    }
  }

  // Handle the highlight button click
  highlightBtn.addEventListener("click", async () => {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
        console.error('No active tab found');
        return;
    }

    console.log(`Ensuring script and sending highlight action to tab: ${tab.id}`);
    highlightBtn.textContent = "Processing...";
    highlightBtn.disabled = true;

    const scriptReady = await ensureContentScript(tab.id);

    if (scriptReady) {
        console.log('Content script ready, sending highlight-all message...');
        try {
            const response = await browserAPI.tabs.sendMessage(tab.id, {
                action: 'highlight-all'
            });

            console.log('Highlight-all message sent, response:', response);

            // Explicitly check if response is defined AND success is true
            if (response && response.success === true) {
                if (response.tfidfDone && response.topicsRequested) {
                    highlightBtn.textContent = "Highlighting...";
                } else if (response.tfidfDone) {
                    highlightBtn.textContent = "TF-IDF Done";
                } else {
                     highlightBtn.textContent = "Processing...";
                }
                highlightBtn.disabled = true; // Keep disabled while processing
            } else {
                // Handle explicit failure OR undefined response
                const errorMessage = response?.error || "No response or failed.";
                console.error("Content script reported failure or did not respond correctly:", errorMessage);
                highlightBtn.textContent = "Error - Try Again";
                highlightBtn.disabled = false;
            }
        } catch (error) {
            // Handle errors during message sending itself
            console.error('Error sending highlight-all message:', error);
            highlightBtn.textContent = "Error - Try Again";
            highlightBtn.disabled = false;
        }
    } else {
        console.error('Content script could not be prepared.');
        highlightBtn.textContent = "Error - Try Again";
        highlightBtn.disabled = false;
    }
  });

  // Listen for topic extraction completion
  browserAPI.runtime.onMessage.addListener((message) => {
    if (message.action === 'topics-extracted') {
      console.log('Topics extracted:', message.topics);
    }
    return true;
  });
});
