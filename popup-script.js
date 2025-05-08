document.addEventListener('DOMContentLoaded', function() {
  // Get references to UI elements
  const highlightBtn = document.getElementById('highlight-btn');
  const useTfidfCheck = document.getElementById('use-tfidf');
  const useMlCheck = document.getElementById('use-ml');
  const topicCountSelect = document.getElementById('topic-count');
  const statusDiv = document.getElementById('status');
  
  // Load saved options
  chrome.storage.local.get(['useTfidf', 'useMl', 'topicCount'], function(items) {
    if (items.useTfidf !== undefined) useTfidfCheck.checked = items.useTfidf;
    if (items.useMl !== undefined) useMlCheck.checked = items.useMl;
    if (items.topicCount !== undefined) topicCountSelect.value = items.topicCount;
  });
  
  // Save options when changed
  useTfidfCheck.addEventListener('change', saveOptions);
  useMlCheck.addEventListener('change', saveOptions);
  topicCountSelect.addEventListener('change', saveOptions);
  
  // Highlight button click handler
  highlightBtn.addEventListener('click', function() {
    // Save options first
    saveOptions();
    
    // Get current options
    const options = {
      useTfidf: useTfidfCheck.checked,
      useMl: useMlCheck.checked,
      topicCount: parseInt(topicCountSelect.value, 10)
    };
    
    // Get the active tab
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      const activeTab = tabs[0];
      
      // Execute the content script with options
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content.js']
      }, function() {
        // Send options to the content script
        chrome.tabs.sendMessage(activeTab.id, {
          action: 'run-highlighting',
          options: options
        }, function(response) {
          if (response && response.success) {
            showStatus('Highlighting started...', 'success');
          } else {
            showStatus('Error starting highlighting', 'error');
          }
        });
      });
    });
  });
  
  // Function to save options
  function saveOptions() {
    const options = {
      useTfidf: useTfidfCheck.checked,
      useMl: useMlCheck.checked,
      topicCount: topicCountSelect.value
    };
    
    chrome.storage.local.set(options);
  }
  
  // Function to show status message
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
    statusDiv.style.display = 'block';
    
    setTimeout(function() {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});