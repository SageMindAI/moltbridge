import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("MoltBridgeSplitter", function () {
  // Shared fixture: deploys mock USDC + splitter
  async function deployFixture() {
    const [owner, platformWallet, broker1, broker2, payer] = await ethers.getSigners();

    // Deploy mock ERC20 (USDC)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy splitter
    const Splitter = await ethers.getContractFactory("MoltBridgeSplitter");
    const splitter = await Splitter.deploy(
      await usdc.getAddress(),
      platformWallet.address
    );

    // Mint USDC to payer (10,000 USDC = 10_000_000_000 with 6 decimals)
    await usdc.mint(payer.address, 10_000_000_000n);

    return { splitter, usdc, owner, platformWallet, broker1, broker2, payer };
  }

  describe("Deployment", function () {
    it("sets correct owner, USDC address, and platform wallet", async function () {
      const { splitter, usdc, owner, platformWallet } = await loadFixture(deployFixture);
      expect(await splitter.owner()).to.equal(owner.address);
      expect(await splitter.usdc()).to.equal(await usdc.getAddress());
      expect(await splitter.platformWallet()).to.equal(platformWallet.address);
    });

    it("rejects zero address for USDC", async function () {
      const Splitter = await ethers.getContractFactory("MoltBridgeSplitter");
      const [_, platformWallet] = await ethers.getSigners();
      await expect(
        Splitter.deploy(ethers.ZeroAddress, platformWallet.address)
      ).to.be.revertedWith("Invalid USDC address");
    });

    it("rejects zero address for platform wallet", async function () {
      const Splitter = await ethers.getContractFactory("MoltBridgeSplitter");
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      await expect(
        Splitter.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid platform wallet");
    });
  });

  describe("Broker Registration", function () {
    it("registers a broker with Founding tier", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await expect(splitter.registerBrokerWallet(brokerId, broker1.address, 2)) // 2 = Founding
        .to.emit(splitter, "BrokerRegistered")
        .withArgs(brokerId, broker1.address, 2);

      expect(await splitter.isBrokerRegistered(brokerId)).to.be.true;
    });

    it("prevents duplicate broker registration", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);
      await expect(
        splitter.registerBrokerWallet(brokerId, broker1.address, 0)
      ).to.be.revertedWith("Broker already registered");
    });

    it("only owner can register brokers", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await expect(
        splitter.connect(broker1).registerBrokerWallet(brokerId, broker1.address, 0)
      ).to.be.revertedWith("Not owner");
    });

    it("broker can update their own wallet", async function () {
      const { splitter, broker1, broker2 } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);

      await expect(
        splitter.connect(broker1).updateBrokerWallet(brokerId, broker2.address)
      )
        .to.emit(splitter, "BrokerWalletUpdated")
        .withArgs(brokerId, broker1.address, broker2.address);
    });

    it("non-broker cannot update wallet", async function () {
      const { splitter, broker1, broker2 } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);

      await expect(
        splitter.connect(broker2).updateBrokerWallet(brokerId, broker2.address)
      ).to.be.revertedWith("Not broker wallet owner");
    });
  });

  describe("Payment Splitting", function () {
    it("splits payment at Founding tier (50/50)", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");
      const amount = 1_000_000n; // 1 USDC

      // Register broker as Founding
      await splitter.registerBrokerWallet(brokerId, broker1.address, 2);

      // Payer approves splitter
      await usdc.connect(payer).approve(await splitter.getAddress(), amount);

      // Split payment
      await expect(splitter.connect(payer).split(paymentId, brokerId, amount))
        .to.emit(splitter, "PaymentSplit")
        .withArgs(paymentId, payer.address, brokerId, amount, 500_000n, 500_000n);

      // Verify balances
      expect(await usdc.balanceOf(broker1.address)).to.equal(500_000n);
      expect(await usdc.balanceOf(platformWallet.address)).to.equal(500_000n);
    });

    it("splits payment at Early tier (40/60)", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");
      const amount = 1_000_000n;

      await splitter.registerBrokerWallet(brokerId, broker1.address, 1); // Early
      await usdc.connect(payer).approve(await splitter.getAddress(), amount);
      await splitter.connect(payer).split(paymentId, brokerId, amount);

      expect(await usdc.balanceOf(broker1.address)).to.equal(400_000n);
      expect(await usdc.balanceOf(platformWallet.address)).to.equal(600_000n);
    });

    it("splits payment at Standard tier (30/70)", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");
      const amount = 1_000_000n;

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0); // Standard
      await usdc.connect(payer).approve(await splitter.getAddress(), amount);
      await splitter.connect(payer).split(paymentId, brokerId, amount);

      expect(await usdc.balanceOf(broker1.address)).to.equal(300_000n);
      expect(await usdc.balanceOf(platformWallet.address)).to.equal(700_000n);
    });

    it("rejects duplicate payment ID", async function () {
      const { splitter, usdc, broker1, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");
      const amount = 1_000_000n;

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);
      await usdc.connect(payer).approve(await splitter.getAddress(), amount * 2n);

      await splitter.connect(payer).split(paymentId, brokerId, amount);
      await expect(
        splitter.connect(payer).split(paymentId, brokerId, amount)
      ).to.be.revertedWith("Payment ID already used");
    });

    it("rejects zero amount", async function () {
      const { splitter, broker1, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);
      await expect(
        splitter.connect(payer).split(ethers.id("p"), brokerId, 0)
      ).to.be.revertedWith("Amount must be positive");
    });

    it("rejects unregistered broker", async function () {
      const { splitter, payer } = await loadFixture(deployFixture);
      const fakeBrokerId = ethers.id("fake-broker");

      await expect(
        splitter.connect(payer).split(ethers.id("p"), fakeBrokerId, 1_000_000n)
      ).to.be.revertedWith("Broker not registered");
    });
  });

  describe("Refunds", function () {
    it("full refund returns total to payer", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");
      const amount = 1_000_000n;

      await splitter.registerBrokerWallet(brokerId, broker1.address, 2); // Founding 50/50
      await usdc.connect(payer).approve(await splitter.getAddress(), amount);
      await splitter.connect(payer).split(paymentId, brokerId, amount);

      // Broker and platform approve splitter for refund
      await usdc.connect(broker1).approve(await splitter.getAddress(), 500_000n);
      await usdc.connect(platformWallet).approve(await splitter.getAddress(), 500_000n);

      const payerBalanceBefore = await usdc.balanceOf(payer.address);

      await expect(splitter.refund(paymentId))
        .to.emit(splitter, "Refunded")
        .withArgs(paymentId, payer.address, amount);

      expect(await usdc.balanceOf(payer.address)).to.equal(payerBalanceBefore + amount);
    });

    it("prevents double refund", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 2);
      await usdc.connect(payer).approve(await splitter.getAddress(), 1_000_000n);
      await splitter.connect(payer).split(paymentId, brokerId, 1_000_000n);

      await usdc.connect(broker1).approve(await splitter.getAddress(), 500_000n);
      await usdc.connect(platformWallet).approve(await splitter.getAddress(), 500_000n);

      await splitter.refund(paymentId);
      await expect(splitter.refund(paymentId)).to.be.revertedWith("Already refunded");
    });

    it("partial refund from platform", async function () {
      const { splitter, usdc, broker1, platformWallet, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0); // Standard
      await usdc.connect(payer).approve(await splitter.getAddress(), 1_000_000n);
      await splitter.connect(payer).split(paymentId, brokerId, 1_000_000n);

      // Platform approves partial refund
      await usdc.connect(platformWallet).approve(await splitter.getAddress(), 200_000n);

      await expect(splitter.partialRefund(paymentId, 200_000n))
        .to.emit(splitter, "PartialRefunded")
        .withArgs(paymentId, payer.address, 200_000n);
    });

    it("only owner can refund", async function () {
      const { splitter, usdc, broker1, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 0);
      await usdc.connect(payer).approve(await splitter.getAddress(), 1_000_000n);
      await splitter.connect(payer).split(paymentId, brokerId, 1_000_000n);

      await expect(
        splitter.connect(payer).refund(paymentId)
      ).to.be.revertedWith("Not owner");
    });
  });

  describe("Admin", function () {
    it("owner can update platform wallet", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      await splitter.updatePlatformWallet(broker1.address);
      expect(await splitter.platformWallet()).to.equal(broker1.address);
    });

    it("owner can transfer ownership", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      await splitter.transferOwnership(broker1.address);
      expect(await splitter.owner()).to.equal(broker1.address);
    });

    it("non-owner cannot transfer ownership", async function () {
      const { splitter, broker1 } = await loadFixture(deployFixture);
      await expect(
        splitter.connect(broker1).transferOwnership(broker1.address)
      ).to.be.revertedWith("Not owner");
    });
  });

  describe("View Functions", function () {
    it("returns correct broker share basis points", async function () {
      const { splitter } = await loadFixture(deployFixture);
      expect(await splitter.getBrokerShareBps(0)).to.equal(3000n); // Standard
      expect(await splitter.getBrokerShareBps(1)).to.equal(4000n); // Early
      expect(await splitter.getBrokerShareBps(2)).to.equal(5000n); // Founding
    });

    it("returns payment record", async function () {
      const { splitter, usdc, broker1, payer } = await loadFixture(deployFixture);
      const brokerId = ethers.id("broker-001");
      const paymentId = ethers.id("payment-001");

      await splitter.registerBrokerWallet(brokerId, broker1.address, 2);
      await usdc.connect(payer).approve(await splitter.getAddress(), 1_000_000n);
      await splitter.connect(payer).split(paymentId, brokerId, 1_000_000n);

      const record = await splitter.getPayment(paymentId);
      expect(record.totalAmount).to.equal(1_000_000n);
      expect(record.brokerAmount).to.equal(500_000n);
      expect(record.platformAmount).to.equal(500_000n);
      expect(record.refunded).to.be.false;
    });
  });
});
