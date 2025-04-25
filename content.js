console.log('Content script loaded');

// Helper to check if we're using Firefox or Chrome
const isFirefox = typeof browser !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;

// State tracking to prevent duplicate operations
const state = {
  tfidfHighlighted: false,
  topicsRequested: false,
  topicsHighlighted: false
};

// Listen for messages from the background script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Content script received message:', message);

    switch (message.action) {
        case 'ping':
            console.log('Content script received ping');
            sendResponse({ status: 'pong' });
            break;

        case 'highlight-all':
            console.log('Content script received highlight-all request');
            try {
                // Clear previous highlights FIRST
                clearHighlights();

                // 1. Perform TF-IDF highlighting (synchronous)
                if (!state.tfidfHighlighted) {
                    console.log('Performing TF-IDF highlighting...');
                    const text = getMainText();
                    if (text && text.trim().length > 0) {
                        const importantSentences = computeTFIDF(text);
                        highlightSentences(importantSentences);
                        console.log('TF-IDF highlighting done.');
                    } else {
                        console.warn("No text found for TF-IDF highlighting.");
                    }
                } else {
                    console.log('TF-IDF already highlighted, skipping.');
                }

                // 2. Initiate Topic Extraction (asynchronous via background)
                if (!state.topicsRequested) {
                    console.log('Initiating topic extraction via background...');
                    // Generate a unique ID for this request
                    const requestId = `extract-${Date.now()}-tab${sender.tab?.id || 'unknown'}-${Math.random().toString(36).substring(2, 9)}`;
                    extractAndSendTopics(requestId); // Sets state.topicsRequested
                    console.log('Topic extraction initiated.');
                    // Send response indicating TF-IDF is done and topics are requested
                    sendResponse({ success: true, tfidfDone: state.tfidfHighlighted, topicsRequested: state.topicsRequested });
                } else {
                     console.log('Topic extraction already requested, skipping initiation.');
                     // Send response indicating current state
                     sendResponse({ success: true, tfidfDone: state.tfidfHighlighted, topicsRequested: state.topicsRequested });
                }
                // Since response is sent synchronously here, return false.
                return false;

            } catch (error) {
                 console.error("Error during highlight-all:", error);
                 sendResponse({ success: false, error: error.message });
                 return false; // Indicate sync response handled
            }

        // Renamed from highlight-topics to match background message
        case 'topics-extracted':
            console.log('Content script received topics-extracted request with data:', message);
            // Check for the nested topics array: message.topics.topics
            if (message.topics && message.topics.topics && Array.isArray(message.topics.topics)) {
                highlightTopics(message.topics.topics);
                sendResponse({ status: 'topic highlighting done' });
            } else {
                console.error('Invalid or missing nested topics array received (message.topics.topics):', message.topics);
                sendResponse({ status: 'error', message: 'Invalid topic data structure' });
            }
            break; // Added break

        case 'clear-highlights':
            console.log('Content script received clear-highlights request');
            clearHighlights(); // Resets state flags
            sendResponse({ status: 'highlights cleared' });
            break; // Added break

        // Handle errors sent from background
        case 'error':
             console.error('Received error message from background:', message.error);
             // Optionally display this error to the user on the page
             sendResponse({ status: 'error acknowledged' });
             break;

        default:
            console.warn('Unknown action received:', message.action);
            // Don't send a response for unknown actions, might interfere
            // sendResponse({ status: 'error', message: 'Unknown action' });
    }

    // Default return value for synchronous message handling
    return false;
});

function getMainText() {
  const paragraphs = document.querySelectorAll("p");
  return Array.from(paragraphs).map(p => p.innerText).join(" \n");
}

function computeTFIDF(text) {
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
  document.querySelectorAll("p").forEach(p => {
    importantSentences.forEach(({ sentence }) => {
      const trimmedSentence = sentence.trim();
      if (trimmedSentence && p.innerText.includes(trimmedSentence)) { // Check for non-empty sentence
        try {
          // Use a regex to replace globally and avoid issues with special chars in sentence
          const regex = new RegExp(escapeRegExp(trimmedSentence), 'g');
          // Add class 'tfidf-highlight' and keep yellow background
          p.innerHTML = p.innerHTML.replace(
            regex,
            `<span class='tfidf-highlight' style='background-color: yellow;'>${trimmedSentence}</span>`
          );
        } catch (e) {
          console.error("Error highlighting TF-IDF sentence:", e, trimmedSentence);
        }
      }
    });
  });
  state.tfidfHighlighted = true; // Update state
}

// Function to clear previous highlights
function clearHighlights() {
    console.log("Clearing previous highlights");
    // Select both topic and tfidf highlights
    const highlights = document.querySelectorAll('span.topic-highlight, span.tfidf-highlight');
    highlights.forEach(span => {
        const parent = span.parentNode;
        // Replace the span with its text content
        if (parent) { // Check if parent exists
            while (span.firstChild) {
                parent.insertBefore(span.firstChild, span);
            }
            parent.removeChild(span);
            // Normalize the parent node to merge adjacent text nodes
            parent.normalize();
        }
    });
    console.log(`Cleared ${highlights.length} highlights.`);
    // Reset ALL state flags when clearing
    state.tfidfHighlighted = false;
    state.topicsRequested = false; // Reset request flag too
    state.topicsHighlighted = false;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
  }
  
// Highlight topics by finding mention text using Regex (similar to TF-IDF)
function highlightTopics(topics) {
    console.log("Highlighting topics using Regex text matching:", topics);
    if (!topics || !Array.isArray(topics) || topics.length === 0) {
        console.warn("No valid topics array provided for highlighting.");
        return;
    }
  
    // 1. Collect unique, non-empty mention texts with their context
    const mentionMap = new Map(); // Use a Map to store text -> {topic, type}
    topics.forEach(topic => {
        if (topic && topic.entityDetails) {
            topic.entityDetails.forEach(detail => {
                if (detail && detail.mentions) {
                    detail.mentions.forEach(mention => {
                        if (mention && mention.text && mention.text.trim()) {
                            const trimmedText = mention.text.trim();
                            // Store the first encountered topic/type for a given text
                            if (!mentionMap.has(trimmedText)) {
                                mentionMap.set(trimmedText, {
                                    topic: topic.topic || 'Unknown Topic',
                                    type: detail.type || 'Unknown Type'
                                });
                            }
                        }
                    });
                }
            });
        }
    });

    const uniqueMentions = Array.from(mentionMap.entries()); // Array of [text, {topic, type}]

    console.log(`Found ${uniqueMentions.length} unique mention texts to highlight.`);
    if (uniqueMentions.length === 0) {
        state.topicsHighlighted = true; // Mark as done even if nothing to highlight
        return;
    }

    // 2. Iterate through target elements (e.g., <p> tags)
    document.querySelectorAll("p").forEach(p => {
        // Avoid processing paragraphs that are already fully highlighted or irrelevant
        // Check if the paragraph itself or any ancestor has the highlight class
        if (p.closest('.topic-highlight, .tfidf-highlight')) {
            return;
        }

        let originalHTML = p.innerHTML;
        let modifiedHTML = originalHTML;

        uniqueMentions.forEach(([mentionText, mentionInfo]) => {
            const title = `Topic: ${mentionInfo.topic} (${mentionInfo.type})`;
            try {
                // Create a RegExp to find the mention text globally, with word boundaries.
                // Ensure the regex doesn't match inside existing HTML tags (basic attempt)
                const regex = new RegExp(`(?<!<[^>]*)\\b(${escapeRegExp(mentionText)})\\b(?![^<]*>)`, 'gi'); // Case-insensitive

                modifiedHTML = modifiedHTML.replace(
                    regex,
                    (match) => {
                        // Basic check to avoid re-highlighting within the same pass
                        // A more robust solution would involve DOM parsing, but this is the requested approach
                        if (match.includes('topic-highlight')) {
                            return match; // Don't re-wrap if already highlighted (simple check)
                        }
                        return `<span class='topic-highlight' style='background-color: pink;' title='${title}'>${match}</span>`;
                    }
                );
            } catch (e) {
                console.error("Error creating or applying regex for mention:", mentionText, e);
            }
        });

        // Only update innerHTML if changes were actually made to avoid unnecessary reflows
        if (modifiedHTML !== originalHTML) {
            // Check again before modifying to ensure no other process highlighted it
            if (!p.closest('.topic-highlight, .tfidf-highlight')) {
                p.innerHTML = modifiedHTML;
            }
        }
    });

    console.log("Topic highlighting via Regex finished.");
    state.topicsHighlighted = true; // Update state
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  // Only auto-highlight if directly executed via executeScript
  if (window._directlyExecuted) {
    console.log('Content script executed directly, running TF-IDF highlighting');
    const text = getMainText();
    const importantSentences = computeTFIDF(text);
    highlightSentences(importantSentences);
  } else {
    // Set a flag for subsequent loads
    window._directlyExecuted = true;
  }
} else {
  document.addEventListener('DOMContentLoaded', () => {
    if (window._directlyExecuted) {
      console.log('Content script executed directly, running TF-IDF highlighting on DOMContentLoaded');
      const text = getMainText();
      const importantSentences = computeTFIDF(text);
      highlightSentences(importantSentences);
    }
    window._directlyExecuted = true;
  });
}

async function extractAndSendTopics(requestId) {
    if (state.topicsRequested) {
        console.log(`Topic extraction already requested for this page load (ID: ${requestId}), skipping.`);
        return;
    }
    state.topicsRequested = true; // Set flag early
    console.log(`Starting topic extraction process, Request ID: ${requestId}`);
    try {
        const text = getMainText();
        if (!text || text.trim().length === 0) {
            console.warn("No text found for topic extraction.");
            browserAPI.runtime.sendMessage({
                 target: 'background',
                 action: 'topics-extracted', // Report back empty/error
                 topics: [],
                 requestId: requestId,
                 error: 'No text content found on page.'
            });
            return;
        }

        console.log(`Sending text (length: ${text.length}) to background for topic extraction.`);
        // Send text to background script to handle offscreen processing
        browserAPI.runtime.sendMessage({
            target: 'background', // Explicitly target background
            action: 'extract-topics', // Action for background to handle
            text: text,
            requestId: requestId
        });
        console.log(`Message sent to background for topic extraction (Request ID: ${requestId}).`);

    } catch (error) {
        console.error('Error initiating topic extraction:', error);
        state.topicsRequested = false; // Reset flag on error
         browserAPI.runtime.sendMessage({
             target: 'background',
             action: 'topics-extracted', // Report error back
             topics: [],
             requestId: requestId,
             error: `Error in content script: ${error.message}`
         });
    }
}
