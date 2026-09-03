'use strict';
// Medium-length fixture: keeps a run active for a few seconds so tests can
// mutate mid-run conditions (price changes) deterministically.
setTimeout(() => console.log('fixture mid done'), 3000);
