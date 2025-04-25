// Web worker for handling semantic mapping and topic extraction
console.log('Worker script starting');

// Import TensorFlow.js
import * as tf from '@tensorflow/tfjs';
// Import our utility before any other TF operations
import { initializeTensorFlow } from './tf-init.js';

// Apply the patch immediately
initializeTensorFlow(tf, 'worker');

console.log('TensorFlow.js imported and patched in worker:', tf.version);

import { extractTopics } from './backend/semantic_mapping.js';

// Track worker state
const state = {
  initialized: false,
  initializing: false,
  isChromium: false,
  readySent: false,
  lastText: null,
  iterationCount: 0,
  maxIterations: 5
};

// Function to detect browser type
function isChromium() {
  return state.isChromium;
}

// Handle messages from the main thread
self.onmessage = async (event) => {
  console.log('Worker received message:', event.data);
  try {
    const { action, text, topN, options, requestId, isChromium: chromiumFlag, iterationOptions } = event.data;
    
    if (chromiumFlag !== undefined) {
      console.log('Setting Chromium flag to:', chromiumFlag);
      state.isChromium = chromiumFlag;
    }
    
    if (action === 'extractTopics') {
      console.log(`Starting topic extraction for text of length ${text.length}, isChromium: ${isChromium()}`);
      console.time('topic-extraction');
      
      // Store the text for potential iterations later
      state.lastText = text;
      state.iterationCount = 0;
      
      try {
        // Run the topic extraction
        console.log('Calling extractTopics with options:', { topN: topN || 5, options });
        const topics = await extractTopics(
          text, 
          topN || 5, 
          options || {}, 
          isChromium()
        );
        
        console.timeEnd('topic-extraction');
        console.log('Topic extraction succeeded, found topics:', topics);
        
        // Send the results back to the main thread
        self.postMessage({
          action: 'topicsExtracted',
          topics: topics,
          requestId: requestId,
          success: true,
          iteration: state.iterationCount,
          canIterate: true
        });
        console.log('Results sent to parent');
      } catch (error) {
        console.timeEnd('topic-extraction');
        console.error('Topic extraction failed:', error);
        throw error;
      }
    } else if (action === 'continueIteration') {
      // Check if we can continue iterating
      if (!state.lastText) {
        self.postMessage({
          action: 'error',
          error: 'No previous extraction to iterate on',
          requestId: requestId,
          success: false
        });
        return;
      }
      
      // Check if we've reached the max iterations
      if (state.iterationCount >= state.maxIterations) {
        self.postMessage({
          action: 'iterationComplete',
          message: `Reached maximum iterations (${state.maxIterations})`,
          requestId: requestId,
          success: true,
          iteration: state.iterationCount,
          canIterate: false
        });
        return;
      }
      
      // Increment iteration counter
      state.iterationCount++;
      
      console.log(`Continuing topic extraction iteration #${state.iterationCount}`);
      console.time(`iteration-${state.iterationCount}`);
      
      try {
        // Create new options for this iteration, potentially modifying parameters
        // based on iterationOptions or using defaults that change with each iteration
        const iterationOpts = {
          ...(options || {}),
          ...(iterationOptions || {}),
          // Modify parameters based on iteration count
          // For example, gradually increase relevance thresholds
          relevanceThreshold: 0.3 + (state.iterationCount * 0.1),
          // Use different techniques on different iterations
          useCentrality: state.iterationCount % 2 === 1,
          useL2Norm: state.iterationCount % 3 !== 0
        };
        
        console.log(`Iteration #${state.iterationCount} using options:`, iterationOpts);
        
        const topics = await extractTopics(
          state.lastText,
          topN || 5,
          iterationOpts,
          isChromium()
        );
        
        console.timeEnd(`iteration-${state.iterationCount}`);
        console.log(`Iteration #${state.iterationCount} succeeded, found topics:`, topics);
        
        // Send the iteration results back
        self.postMessage({
          action: 'topicsExtracted',
          topics: topics,
          requestId: requestId,
          success: true,
          iteration: state.iterationCount,
          canIterate: state.iterationCount < state.maxIterations
        });
      } catch (error) {
        console.timeEnd(`iteration-${state.iterationCount}`);
        console.error(`Iteration #${state.iterationCount} failed:`, error);
        throw error;
      }
    } else if (action === 'initialize') {
      console.log('Worker received initialize command');
      
      // Avoid duplicate initialization
      if (state.initialized) {
        console.log('Worker already initialized, skipping');
        return;
      }
      
      // Mark as initialized
      state.initialized = true;
    } else if (action === 'resetIterations') {
      // Reset the iteration state
      state.iterationCount = 0;
      console.log('Iteration counter reset');
      
      self.postMessage({
        action: 'iterationReset',
        requestId: requestId,
        success: true
      });
    } else if (action === 'setMaxIterations') {
      // Update the maximum allowed iterations
      if (typeof event.data.maxIterations === 'number' && event.data.maxIterations > 0) {
        state.maxIterations = event.data.maxIterations;
        console.log(`Maximum iterations set to ${state.maxIterations}`);
        
        self.postMessage({
          action: 'maxIterationsSet',
          maxIterations: state.maxIterations,
          requestId: requestId,
          success: true
        });
      } else {
        self.postMessage({
          action: 'error',
          error: 'Invalid maxIterations value',
          requestId: requestId,
          success: false
        });
      }
    } else {
      console.log('Unknown action:', action);
    }
  } catch (error) {
    // Handle errors and send them back to the main thread
    console.error('Worker error:', error);
    
    self.postMessage({
      action: 'error',
      error: error.message || 'Unknown error in worker',
      requestId: event.data?.requestId,
      success: false
    });
    console.log('Error sent to parent');
  }
};

// Notify that the worker is ready (only once)
if (!state.readySent) {
  console.log('Worker script ready, sending ready message');
  self.postMessage({ action: 'ready' });
  state.readySent = true;
}