import { defineBlock } from '@runsett/sdk';
export const operation = defineBlock({
  name: 'operation', version: '1', moduleId: 'operation',
  moduleHash: '1ca6dcfd15ebd590c32f1492b4d26a380bc4f274cca77f044594fd746431a61f',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  effect: 'write', credentialBindings: [], networkMode: 'none',
});
export const retryOperation = defineBlock({ ...operation, maximumAttempts: 3 });
