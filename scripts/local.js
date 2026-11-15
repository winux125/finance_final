import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, custom, defineChain } from 'viem';
import { network } from 'hardhat';

const chain = defineChain({
  id: 31337,
  name: 'Local Hardhat simulation',
  nativeCurrency: { name: 'Simulated Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

export async function deploy({ manualTime = false } = {}) {
  // A fresh in-process EVM for every deploy. No external RPC URL or funded wallet.
  const connection = await network.create('sandbox');
  try {
    const transport = custom(connection.provider, { retryCount: 0 });
    const reader = createPublicClient({ chain, transport });
    const client = createWalletClient({ chain, transport });
    const [buyer, evaluator, auditor, supplierA, supplierB, stranger, intake] = await client.getAddresses();
    const artifactUrl = new URL(
      '../artifacts/contracts/TenderLedger.sol/TenderLedger.json',
      import.meta.url,
    );
    const { abi, bytecode } = JSON.parse(await readFile(artifactUrl, 'utf8'));
    const hash = await client.deployContract({ abi, bytecode, account: buyer, args: [evaluator, auditor, intake] });
    const receipt = await reader.getTransactionReceipt({ hash });
    if (!receipt.contractAddress || receipt.status !== 'success') {
      throw new Error('Local deployment failed');
    }
    const contract = { abi, address: receipt.contractAddress };
    const timestamp = async () => (await reader.getBlock()).timestamp;
    const setNextTimestamp = async next => {
      await connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(next)] });
    };
    return {
      address: receipt.contractAddress,
      buyer, evaluator, auditor, supplierA, supplierB, stranger, intake,
      timestamp,
      async advance(next) {
        await setNextTimestamp(next);
        await connection.provider.request({ method: 'evm_mine' });
      },
      async write(account, functionName, args) {
        // The browser demo advances by user action, even after a long pause.
        if (manualTime) await setNextTimestamp(await timestamp() + 1n);
        const hash = await client.writeContract({ ...contract, account, functionName, args });
        const result = await reader.getTransactionReceipt({ hash });
        if (result.status !== 'success') throw new Error('Local transaction reverted');
        return reader.getTransaction({ hash });
      },
      read(functionName, args) {
        return reader.readContract({ ...contract, functionName, args });
      },
      close() { return connection.close(); },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
