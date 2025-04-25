// Content script for Context Highlighter extension
// This script runs in the context of web pages
console.log('Content script loaded');

// Helper to check if we're using Firefox or Chrome
const isFirefox = typeof browser !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;
console.log('Content script browser:', isFirefox ? 'Firefox' : 'Chrome');

// Insert CSS stylesheet for our elements
function injectStyles() {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .context-highlighter-menu {
      position: fixed;
      top: 10px;
      right: 10px;
      background: white;
      border: 1px solid #ccc;
      border-radius: 5px;
      padding: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      z-index: 9999;
      font-family: Arial, sans-serif;
      font-size: 14px;
      max-width: 300px;
    }
    
    .context-highlighter-title {
      margin: 0 0 10px 0;
    }
    
    .context-highlighter-list {
      padding: 0;
      margin: 0;
      list-style: none;
    }
    
    .context-highlighter-item {
      padding: 5px 0;
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    
    .context-highlighter-color-box {
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-right: 8px;
    }
    
    .context-highlighter-close-btn {
      margin-top: 10px;
      padding: 5px 10px;
      background: #f1f1f1;
      border: 1px solid #ccc;
      border-radius: 3px;
      cursor: pointer;
      width: 100%;
    }
    
    .context-highlighter-yellow {
      background-color: yellow;
    }
    
    .context-highlighter-pink {
      background-color: #ffb6c1;
    }
  `;
  document.head.appendChild(styleElement);
  console.log('Context highlighter styles injected');
}

// Call this function when the script loads
injectStyles();

// Listen for messages from popup or background
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message);
  
  if (message.action === 'extract-page-text') {
    console.log('Extracting page text');
    // Get all text content from the page
    const pageText = extractPageText();
    console.log(`Extracted ${pageText.length} characters of text`);
    if (pageText.length > 500) {
      console.log('Text sample:', pageText.substring(0, 500) + '...');
    } else {
      console.log('Text:', pageText);
    }
    
    console.log('Sending text extraction response back to popup');
    // Make sure to send the response
    sendResponse({ text: pageText });
    
    console.log('Response sent successfully');
    return true;
  } else if (message.action === 'topics-extracted') {
    // Display topics on the page
    console.log('Displaying topics on page:', message.topics);
    highlightTopics(message.topics);
    sendResponse({ success: true });
    return true;
  } else if (message.action === 'highlight-tfidf') {
    console.log('Highlighting with TF-IDF');
    
    // Get the main text from paragraphs
    const text = getMainText();
    
    // Compute important sentences using TF-IDF
    const importantSentences = computeTFIDF(text);
    
    // Highlight the sentences in yellow
    highlightSentences(importantSentences);
    
    sendResponse({ success: true });
    return true;
  }
  
  // Keep the message channel open for async responses
  return true;
});

// Extract meaningful text from the page
function extractPageText() {
  console.log('Starting text extraction');
  // Skip certain elements that typically don't contain relevant content
  const excludeSelectors = [
    'script', 'style', 'noscript', 'header', 'footer', 
    'nav', 'iframe', 'svg', 'path', '[aria-hidden="true"]'
  ].join(',');
  
  console.log('Using exclude selectors:', excludeSelectors);
  
  // Get all text nodes in the body, excluding the ones from elements above
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: node => {
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        
        const parent = node.parentElement;
        
        // Skip hidden elements
        if (window.getComputedStyle(parent).display === 'none' || 
            window.getComputedStyle(parent).visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip excluded elements
        if (parent.closest(excludeSelectors)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Accept non-empty text nodes
        return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );
  
  let text = '';
  let nodeCount = 0;
  let node;
  
  console.log('Walking text nodes');
  while ((node = walker.nextNode())) {
    text += node.textContent.trim() + ' ';
    nodeCount++;
  }
  
  console.log(`Text extraction complete. Found ${nodeCount} text nodes`);
  return text.trim();
}

// Original TF-IDF functions from the old implementation
function getMainText() {
  console.log('Getting main text from paragraphs');
  const paragraphs = document.querySelectorAll("p");
  return Array.from(paragraphs).map(p => p.innerText).join(" \n");
}

function computeTFIDF(text) {
  console.log('Computing TF-IDF scores for sentences');
  const sentences = text.match(/[^.!?]+[.!?]/g) || [];
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const wordFreq = {};
  words.forEach(word => wordFreq[word] = (wordFreq[word] || 0) + 1);
  
  const sentenceScores = sentences.map(sentence => {
    const sentenceWords = sentence.toLowerCase().match(/\b\w+\b/g) || [];
    let score = sentenceWords.reduce((sum, word) => sum + (wordFreq[word] || 0), 0);
    return { sentence, score };
  });
  
  sentenceScores.sort((a, b) => b.score - a.score);
  return sentenceScores.slice(0, Math.max(1, sentenceScores.length * 0.3));
}

function highlightSentences(importantSentences) {
  console.log(`Highlighting ${importantSentences.length} important sentences in yellow`);
  document.querySelectorAll("p").forEach(p => {
    importantSentences.forEach(({ sentence }) => {
      if (p.innerText.includes(sentence.trim())) {
        p.innerHTML = p.innerHTML.replace(
          new RegExp(escapeRegExp(sentence.trim()), 'g'), 
          `<span class="context-highlighter-yellow">${sentence.trim()}</span>`
        );
      }
    });
  });
}

// Highlight topics on the page with the ML approach
function highlightTopics(topics) {
  console.log('Highlighting topics:', topics);
  if (!topics || topics.length === 0) {
    console.log('No topics to highlight');
    return;
  }
  
  // Create container for topic menu
  const menuContainer = document.createElement('div');
  menuContainer.className = 'context-highlighter-menu';
  
  // Create topic list
  const title = document.createElement('h3');
  title.textContent = 'Page Topics';
  title.className = 'context-highlighter-title';
  menuContainer.appendChild(title);
  
  const list = document.createElement('ul');
  list.className = 'context-highlighter-list';
  
  // Use pink for ML topics
  const topicColor = 'context-highlighter-pink'; // CSS class name
  
  // Add each topic with a highlight color
  topics.forEach((topic) => {
    const item = document.createElement('li');
    item.className = 'context-highlighter-item';
    
    const colorBox = document.createElement('span');
    colorBox.className = `context-highlighter-color-box ${topicColor}`;
    
    const text = document.createElement('span');
    text.textContent = topic.topic;
    
    item.appendChild(colorBox);
    item.appendChild(text);
    list.appendChild(item);
    
    // Add click handler to toggle highlights
    item.addEventListener('click', () => {
      console.log(`Toggling highlights for topic: ${topic.topic}`);
      toggleHighlights(topic.topic, topicColor);
    });
  });
  
  menuContainer.appendChild(list);
  
  // Add close button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.className = 'context-highlighter-close-btn';
  closeBtn.addEventListener('click', () => {
    console.log('Closing topic menu');
    document.body.removeChild(menuContainer);
  });
  
  menuContainer.appendChild(closeBtn);
  document.body.appendChild(menuContainer);
  console.log('Topic menu added to page');
  
  // Automatically highlight ALL topics
  console.log(`Auto-highlighting all ${topics.length} topics`);
  topics.forEach(topic => {
    toggleHighlights(topic.topic, topicColor);
  });
}

// Store active highlights
const activeHighlights = {};

// Toggle highlights for a topic
function toggleHighlights(topic, colorClass) {
  console.log(`Toggle highlights for "${topic}" with color class ${colorClass}`);
  
  if (activeHighlights[topic]) {
    console.log(`Removing ${activeHighlights[topic].length} existing highlights for "${topic}"`);
    // Remove highlights
    activeHighlights[topic].forEach(el => {
      el.outerHTML = el.textContent;
    });
    delete activeHighlights[topic];
  } else {
    // Add highlights
    console.log(`Adding highlights for "${topic}"`);
    const regex = new RegExp(`\\b${escapeRegExp(topic)}\\b`, 'gi');
    activeHighlights[topic] = [];
    
    // Walk through all text nodes
    walkTextNodes(document.body, node => {
      const text = node.nodeValue;
      if (regex.test(text)) {
        const span = document.createElement('span');
        span.innerHTML = text.replace(regex, match => {
          return `<mark class="${colorClass}">${match}</mark>`;
        });
        
        const highlights = span.querySelectorAll('mark');
        activeHighlights[topic].push(...highlights);
        
        node.parentNode.replaceChild(span, node);
      }
    });
    console.log(`Added ${activeHighlights[topic].length} highlights for "${topic}"`);
  }
}

// Helper function to escape special characters in regex
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Walks through all text nodes in an element
function walkTextNodes(element, callback) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  let count = 0;
  while ((node = walker.nextNode())) {
    callback(node);
    count++;
  }
  console.log(`Walked ${count} text nodes`);
}
