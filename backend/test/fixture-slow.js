'use strict';
// Slow fixture for cancellation tests: stays alive until killed.
setTimeout(() => console.log('slow fixture done'), 30000);
