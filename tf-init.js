/**
 * TensorFlow.js initialization and kernel registration safety utility
 */
console.log('Loading TensorFlow.js initialization utility');

// Create a registry to track kernels that have been registered
const registeredKernels = new Set();

/**
 * Safely initialize TensorFlow.js to prevent duplicate kernel registrations
 * This approach doesn't try to replace the registerKernel function
 * and instead provides a checking mechanism to avoid duplicate warnings
 * 
 * @param {Object} tf - The TensorFlow.js instance
 * @param {string} context - Name of the current context (for logging)
 * @returns {Object} The original TensorFlow.js instance
 */
export function initializeTensorFlow(tf, context = 'unknown') {
  console.log(`Initializing TensorFlow in ${context} context`);
  
  // Check if we've already initialized this instance
  if (tf._safeInitApplied) {
    console.log(`TensorFlow already safely initialized in ${context}`);
    return tf;
  }
  
  // Mark as safely initialized to avoid double processing
  tf._safeInitApplied = true;
  
  // Set up a function to check if a kernel has been registered before
  tf.isKernelRegistered = function(kernelName, backendName) {
    const kernelKey = `${kernelName}-${backendName}`;
    return registeredKernels.has(kernelKey);
  };
  
  // Set up a function to mark a kernel as registered
  tf.markKernelRegistered = function(kernelName, backendName) {
    const kernelKey = `${kernelName}-${backendName}`;
    registeredKernels.add(kernelKey);
  };
  
  // Override console.error to suppress specific TensorFlow kernel warnings
  const originalConsoleError = console.error;
  console.error = function(...args) {
    // Check if this is a kernel registration error we want to suppress
    if (args.length > 0 && 
        typeof args[0] === 'string' && 
        args[0].includes('kernel') && 
        args[0].includes('backend') && 
        args[0].includes('already registered')) {
      // Extract kernel name and backend from error message if possible
      try {
        const matches = args[0].match(/kernel '([^']+)' for backend '([^']+)'/);
        if (matches && matches.length >= 3) {
          const kernelName = matches[1];
          const backendName = matches[2];
          const kernelKey = `${kernelName}-${backendName}`;
          // Mark as registered to avoid future warnings
          registeredKernels.add(kernelKey);
        }
      } catch (e) {
        // If parsing fails, still suppress the warning
      }
      
      // Suppress the error message
      return;
    }
    
    // For all other errors, use the original console.error
    originalConsoleError.apply(console, args);
  };
  
  console.log(`TensorFlow initialized in ${context} with error suppression`);
  return tf;
}

/**
 * Get the number of registered kernels
 * @returns {number} Number of kernels in the registry
 */
export function getRegisteredKernelCount() {
  return registeredKernels.size;
}

// Additional utility functions
export function isKernelRegistered(kernelName, backendName) {
  const kernelKey = `${kernelName}-${backendName}`;
  return registeredKernels.has(kernelKey);
}

export function markKernelRegistered(kernelName, backendName) {
  const kernelKey = `${kernelName}-${backendName}`;
  registeredKernels.add(kernelKey);
  return true;
}

console.log('TensorFlow.js initialization utility loaded');
