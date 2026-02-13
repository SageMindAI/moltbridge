// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MoltBridge Non-Custodial Payment Splitter
 *
 * Handles USDC micropayments on Base L2. When an introduction succeeds:
 * 1. Requester approves USDC transfer to this contract
 * 2. Contract splits payment between broker and platform
 * 3. Broker receives their tier share immediately
 * 4. Platform receives remainder
 *
 * Uses IERC20 (not payable) since USDC is an ERC-20 token.
 *
 * Broker Tiers (locked at registration):
 * - Founding: 50% broker share
 * - Early: 40% broker share
 * - Standard: 30% broker share
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract MoltBridgeSplitter {
    // --- State ---

    address public owner;
    address public usdc;           // USDC token address on Base L2
    address public platformWallet; // Platform revenue destination

    enum BrokerTier { Standard, Early, Founding }

    struct BrokerInfo {
        address wallet;
        BrokerTier tier;
        bool registered;
    }

    // broker agent_id (bytes32 hash) => BrokerInfo
    mapping(bytes32 => BrokerInfo) public brokers;

    // Payment record for refund support
    struct PaymentRecord {
        bytes32 paymentId;
        address payer;
        address broker;
        uint256 totalAmount;
        uint256 brokerAmount;
        uint256 platformAmount;
        uint256 timestamp;
        bool refunded;
    }

    mapping(bytes32 => PaymentRecord) public payments;

    // Tier share percentages (basis points: 10000 = 100%)
    uint256 public constant FOUNDING_SHARE = 5000;  // 50%
    uint256 public constant EARLY_SHARE = 4000;     // 40%
    uint256 public constant STANDARD_SHARE = 3000;  // 30%
    uint256 public constant BASIS_POINTS = 10000;

    // --- Events ---

    event BrokerRegistered(bytes32 indexed brokerId, address wallet, BrokerTier tier);
    event BrokerWalletUpdated(bytes32 indexed brokerId, address oldWallet, address newWallet);
    event PaymentSplit(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes32 indexed brokerId,
        uint256 totalAmount,
        uint256 brokerAmount,
        uint256 platformAmount
    );
    event Refunded(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event PartialRefunded(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event PlatformWalletUpdated(address oldWallet, address newWallet);
    event OwnerTransferred(address oldOwner, address newOwner);

    // --- Modifiers ---

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // --- Constructor ---

    constructor(address _usdc, address _platformWallet) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_platformWallet != address(0), "Invalid platform wallet");
        owner = msg.sender;
        usdc = _usdc;
        platformWallet = _platformWallet;
    }

    // --- Broker Management ---

    /**
     * Register a broker's wallet and lock their tier permanently.
     * Only callable by owner (MoltBridge backend).
     */
    function registerBrokerWallet(
        bytes32 brokerId,
        address wallet,
        BrokerTier tier
    ) external onlyOwner {
        require(wallet != address(0), "Invalid wallet");
        require(!brokers[brokerId].registered, "Broker already registered");

        brokers[brokerId] = BrokerInfo({
            wallet: wallet,
            tier: tier,
            registered: true
        });

        emit BrokerRegistered(brokerId, wallet, tier);
    }

    /**
     * Update a broker's wallet address.
     * Only the broker themselves (current wallet) can update.
     */
    function updateBrokerWallet(bytes32 brokerId, address newWallet) external {
        require(newWallet != address(0), "Invalid wallet");
        BrokerInfo storage broker = brokers[brokerId];
        require(broker.registered, "Broker not registered");
        require(msg.sender == broker.wallet, "Not broker wallet owner");

        address oldWallet = broker.wallet;
        broker.wallet = newWallet;

        emit BrokerWalletUpdated(brokerId, oldWallet, newWallet);
    }

    // --- Payment Splitting ---

    /**
     * Split a USDC payment between broker and platform.
     * Caller must have approved this contract for the totalAmount.
     *
     * @param paymentId Unique payment identifier
     * @param brokerId The broker receiving commission
     * @param totalAmount Total USDC amount (6 decimals)
     */
    function split(
        bytes32 paymentId,
        bytes32 brokerId,
        uint256 totalAmount
    ) external {
        require(totalAmount > 0, "Amount must be positive");
        require(payments[paymentId].totalAmount == 0, "Payment ID already used");

        BrokerInfo storage broker = brokers[brokerId];
        require(broker.registered, "Broker not registered");

        uint256 brokerShare = getBrokerShareBps(broker.tier);
        uint256 brokerAmount = (totalAmount * brokerShare) / BASIS_POINTS;
        uint256 platformAmount = totalAmount - brokerAmount;

        // Record payment before transfers (reentrancy guard)
        payments[paymentId] = PaymentRecord({
            paymentId: paymentId,
            payer: msg.sender,
            broker: broker.wallet,
            totalAmount: totalAmount,
            brokerAmount: brokerAmount,
            platformAmount: platformAmount,
            timestamp: block.timestamp,
            refunded: false
        });

        // Transfer USDC from payer to broker
        IERC20 token = IERC20(usdc);
        require(
            token.transferFrom(msg.sender, broker.wallet, brokerAmount),
            "Broker transfer failed"
        );

        // Transfer USDC from payer to platform
        require(
            token.transferFrom(msg.sender, platformWallet, platformAmount),
            "Platform transfer failed"
        );

        emit PaymentSplit(paymentId, msg.sender, brokerId, totalAmount, brokerAmount, platformAmount);
    }

    // --- Refunds ---

    /**
     * Full refund — returns totalAmount to payer.
     * Broker and platform must have sufficient balance.
     * Only callable by owner (dispute resolution).
     */
    function refund(bytes32 paymentId) external onlyOwner {
        PaymentRecord storage payment = payments[paymentId];
        require(payment.totalAmount > 0, "Payment not found");
        require(!payment.refunded, "Already refunded");

        payment.refunded = true;

        IERC20 token = IERC20(usdc);

        // Broker returns their share
        require(
            token.transferFrom(payment.broker, payment.payer, payment.brokerAmount),
            "Broker refund failed"
        );

        // Platform returns its share
        require(
            token.transferFrom(platformWallet, payment.payer, payment.platformAmount),
            "Platform refund failed"
        );

        emit Refunded(paymentId, payment.payer, payment.totalAmount);
    }

    /**
     * Partial refund — returns specified amount to payer from platform wallet.
     * Only callable by owner (dispute resolution).
     */
    function partialRefund(bytes32 paymentId, uint256 amount) external onlyOwner {
        PaymentRecord storage payment = payments[paymentId];
        require(payment.totalAmount > 0, "Payment not found");
        require(!payment.refunded, "Already refunded");
        require(amount > 0 && amount <= payment.totalAmount, "Invalid refund amount");

        IERC20 token = IERC20(usdc);
        require(
            token.transferFrom(platformWallet, payment.payer, amount),
            "Partial refund failed"
        );

        emit PartialRefunded(paymentId, payment.payer, amount);
    }

    // --- View Functions ---

    function getBrokerShareBps(BrokerTier tier) public pure returns (uint256) {
        if (tier == BrokerTier.Founding) return FOUNDING_SHARE;
        if (tier == BrokerTier.Early) return EARLY_SHARE;
        return STANDARD_SHARE;
    }

    function getPayment(bytes32 paymentId) external view returns (PaymentRecord memory) {
        return payments[paymentId];
    }

    function isBrokerRegistered(bytes32 brokerId) external view returns (bool) {
        return brokers[brokerId].registered;
    }

    // --- Admin ---

    function updatePlatformWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "Invalid wallet");
        address old = platformWallet;
        platformWallet = newWallet;
        emit PlatformWalletUpdated(old, newWallet);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        address old = owner;
        owner = newOwner;
        emit OwnerTransferred(old, newOwner);
    }
}
