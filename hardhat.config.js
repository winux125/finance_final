import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default {
  solidity: {
    version: '0.8.28',
    path: require.resolve('solc/soljson.js'),
    preferWasm: true,
  },
  networks: {
    sandbox: { type: 'edr-simulated', chainType: 'l1', chainId: 31337 },
  },
};
