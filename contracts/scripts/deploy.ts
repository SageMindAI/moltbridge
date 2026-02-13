/**
 * MoltBridgeSplitter Deployment Script
 *
 * Deploys the payment splitter to Base L2.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network base-sepolia   # Testnet
 *   npx hardhat run scripts/deploy.ts --network base            # Mainnet
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   - Deployer wallet private key
 *   USDC_ADDRESS           - USDC contract address on target network
 *   PLATFORM_WALLET        - Platform revenue destination wallet
 */

import { ethers } from "hardhat";

// USDC addresses per network
const USDC_ADDRESSES: Record<string, string> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",           // USDC on Base Mainnet
  hardhat: "",  // Will use mock
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("\n=== MoltBridgeSplitter Deployment ===\n");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  // Get USDC address
  let usdcAddress = process.env.USDC_ADDRESS || USDC_ADDRESSES[networkName];
  if (!usdcAddress) {
    throw new Error(`No USDC address configured for network: ${networkName}`);
  }

  // For local testing, deploy a mock USDC
  if (networkName === "hardhat" || networkName === "localhost") {
    console.log("Deploying mock USDC for testing...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUsdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await mockUsdc.waitForDeployment();
    usdcAddress = await mockUsdc.getAddress();
    console.log(`Mock USDC: ${usdcAddress}`);
  }

  // Get platform wallet
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  console.log(`USDC:     ${usdcAddress}`);
  console.log(`Platform: ${platformWallet}\n`);

  // Deploy
  console.log("Deploying MoltBridgeSplitter...");
  const Splitter = await ethers.getContractFactory("MoltBridgeSplitter");
  const splitter = await Splitter.deploy(usdcAddress, platformWallet);
  await splitter.waitForDeployment();

  const address = await splitter.getAddress();
  console.log(`\nDeployed: ${address}`);

  // Verify deployment
  console.log("\nVerifying deployment...");
  console.log(`  Owner:    ${await splitter.owner()}`);
  console.log(`  USDC:     ${await splitter.usdc()}`);
  console.log(`  Platform: ${await splitter.platformWallet()}`);

  console.log("\n=== Deployment Complete ===\n");
  console.log("Next steps:");
  console.log(`  1. Verify on BaseScan: npx hardhat verify ${address} ${usdcAddress} ${platformWallet} --network ${networkName}`);
  console.log(`  2. Set MOLTBRIDGE_SPLITTER_ADDRESS=${address} in your .env`);
  console.log(`  3. Register broker wallets via registerBrokerWallet()`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
