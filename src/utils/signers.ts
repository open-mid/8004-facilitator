import { createWalletClient, http, publicActions } from "viem";
import { baseSepolia, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toFacilitatorEvmSigner } from "@x402/evm";

export function createFacilitatorSigners(privateKey: `0x${string}`) {
  const evmAccount = privateKeyToAccount(privateKey);

  const baseSepoliaClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  const baseMainnetClient = createWalletClient({
    account: evmAccount,
    chain: base,
    transport: http(),
  }).extend(publicActions);

  const baseSepoliaSigner = toFacilitatorEvmSigner({
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      baseSepoliaClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
    }) => baseSepoliaClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      baseSepoliaClient.writeContract({
        ...args,
        args: args.args || [],
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      baseSepoliaClient.waitForTransactionReceipt(args),
  });

  const baseMainnetSigner = toFacilitatorEvmSigner({
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      baseMainnetClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
    }) => baseMainnetClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      baseMainnetClient.writeContract({
        ...args,
        args: args.args || [],
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      baseMainnetClient.waitForTransactionReceipt(args),
  });

  return {
    evmAccount,
    baseSepoliaSigner,
    baseMainnetSigner,
  };
}
