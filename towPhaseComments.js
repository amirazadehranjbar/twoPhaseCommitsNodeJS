/**
 * Two-Phase Commit Functions for MongoDB Transactions
 *
 * These functions implement a manual two-phase commit protocol for MongoDB
 * that works WITHOUT requiring a replica set configuration.
 *
 * Usage:
 *   const { executeTransfer } = require('./two-phase-commit');
 *   await executeTransfer({ sourceId, destId, amount, models });
 */

// ============================================================================
// Core Two-Phase Commit Functions
// ============================================================================

/**
 * Phase 1: Initialize transaction and lock accounts
 * @param {Object} params
 * @param {string} params.transactionId - Transaction document ID
 * @param {Object} params.TransactionModel - Mongoose Transaction model
 * @param {Object} params.AccountModel - Mongoose Account model
 * @returns {Object} Transaction document
 */
async function startTransaction({ transactionId, TransactionModel, AccountModel }) {
    const transaction = await TransactionModel.findOneAndUpdate(
        { _id: transactionId, state: "initial" },
        {
            $set: { state: "pending" },
            $currentDate: { lastModified: true }
        },
        { new: true }
    );

    if (!transaction) {
        throw new Error("Transaction not found or already started");
    }

    // Lock both accounts by adding transaction to pending list
    await AccountModel.updateOne(
        { _id: transaction.source },
        { $addToSet: { pendingTransactions: transaction._id } }
    );

    await AccountModel.updateOne(
        { _id: transaction.destination },
        { $addToSet: { pendingTransactions: transaction._id } }
    );

    return transaction;
}

/**
 * Phase 2: Apply the transaction (transfer funds)
 * @param {Object} params
 * @param {string} params.transactionId - Transaction document ID
 * @param {Object} params.TransactionModel - Mongoose Transaction model
 * @param {Object} params.AccountModel - Mongoose Account model
 * @returns {Object} Transaction document
 */
async function applyTransaction({ transactionId, TransactionModel, AccountModel }) {
    const transaction = await TransactionModel.findOne({ _id: transactionId });

    if (!transaction || transaction.state !== "pending") {
        throw new Error("Transaction not in pending state");
    }

    // Deduct from source account
    const sourceUpdate = await AccountModel.updateOne(
        {
            _id: transaction.source,
            pendingTransactions: transaction._id,
            balance: { $gte: transaction.value }
        },
        { $inc: { balance: -transaction.value } }
    );

    if (sourceUpdate.modifiedCount === 0) {
        throw new Error("Insufficient balance or source account not found");
    }

    // Add to destination account
    await AccountModel.updateOne(
        {
            _id: transaction.destination,
            pendingTransactions: transaction._id
        },
        { $inc: { balance: transaction.value } }
    );

    // Mark transaction as applied
    await TransactionModel.updateOne(
        { _id: transaction._id },
        {
            $set: { state: "applied" },
            $currentDate: { lastModified: true }
        }
    );

    return transaction;
}

/**
 * Phase 3: Complete transaction and unlock accounts
 * @param {Object} params
 * @param {string} params.transactionId - Transaction document ID
 * @param {Object} params.TransactionModel - Mongoose Transaction model
 * @param {Object} params.AccountModel - Mongoose Account model
 * @returns {Object} Transaction document
 */
async function completeTransaction({ transactionId, TransactionModel, AccountModel }) {
    const transaction = await TransactionModel.findOne({ _id: transactionId });

    if (!transaction || transaction.state !== "applied") {
        throw new Error("Transaction not in applied state");
    }

    // Remove from pending lists (unlock accounts)
    await AccountModel.updateOne(
        { _id: transaction.source },
        { $pull: { pendingTransactions: transaction._id } }
    );

    await AccountModel.updateOne(
        { _id: transaction.destination },
        { $pull: { pendingTransactions: transaction._id } }
    );

    // Mark transaction as done
    await TransactionModel.updateOne(
        { _id: transaction._id },
        {
            $set: { state: "done" },
            $currentDate: { lastModified: true }
        }
    );

    return transaction;
}

/**
 * Rollback: Cancel and reverse a transaction
 * @param {Object} params
 * @param {string} params.transactionId - Transaction document ID
 * @param {Object} params.TransactionModel - Mongoose Transaction model
 * @param {Object} params.AccountModel - Mongoose Account model
 * @returns {Object} Transaction document
 */
async function cancelTransaction({ transactionId, TransactionModel, AccountModel }) {
    const transaction = await TransactionModel.findOne({ _id: transactionId });

    if (!transaction) {
        throw new Error("Transaction not found");
    }

    // Set state to canceling
    await TransactionModel.updateOne(
        { _id: transaction._id },
        {
            $set: { state: "canceling" },
            $currentDate: { lastModified: true }
        }
    );

    // If transaction was applied, reverse it
    if (transaction.state === "applied") {
        await AccountModel.updateOne(
            { _id: transaction.source },
            { $inc: { balance: transaction.value } }
        );

        await AccountModel.updateOne(
            { _id: transaction.destination },
            { $inc: { balance: -transaction.value } }
        );
    }

    // Remove from pending lists
    await AccountModel.updateOne(
        { _id: transaction.source },
        { $pull: { pendingTransactions: transaction._id } }
    );

    await AccountModel.updateOne(
        { _id: transaction.destination },
        { $pull: { pendingTransactions: transaction._id } }
    );

    // Mark as canceled
    await TransactionModel.updateOne(
        { _id: transaction._id },
        {
            $set: { state: "canceled" },
            $currentDate: { lastModified: true }
        }
    );

    return transaction;
}

// ============================================================================
// High-Level API Functions
// ============================================================================

/**
 * Execute a complete fund transfer using two-phase commit
 * @param {Object} params
 * @param {string} params.sourceId - Source account ID
 * @param {string} params.destId - Destination account ID
 * @param {number} params.amount - Amount to transfer
 * @param {Object} params.models - Object containing AccountModel and TransactionModel
 * @param {Object} params.models.AccountModel - Mongoose Account model
 * @param {Object} params.models.TransactionModel - Mongoose Transaction model
 * @returns {Object} Result object with success status and transaction
 */
async function executeTransfer({ sourceId, destId, amount, models }) {
    const { AccountModel, TransactionModel } = models;

    // Validate inputs
    if (!sourceId || !destId || !amount) {
        throw new Error("sourceId, destId, and amount are required");
    }

    if (amount <= 0) {
        throw new Error("Amount must be positive");
    }

    if (sourceId === destId) {
        throw new Error("Source and destination accounts cannot be the same");
    }

    // Create transaction document
    const transaction = await TransactionModel.create({
        source: sourceId,
        destination: destId,
        value: amount,
        state: "initial"
    });

    try {
        // Execute two-phase commit
        await startTransaction({
            transactionId: transaction._id,
            TransactionModel,
            AccountModel
        });

        await applyTransaction({
            transactionId: transaction._id,
            TransactionModel,
            AccountModel
        });

        await completeTransaction({
            transactionId: transaction._id,
            TransactionModel,
            AccountModel
        });

        return {
            success: true,
            transactionId: transaction._id,
            message: "Transfer completed successfully"
        };
    } catch (error) {
        // Rollback on any error
        try {
            await cancelTransaction({
                transactionId: transaction._id,
                TransactionModel,
                AccountModel
            });
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError);
        }

        throw new Error(`Transfer failed: ${error.message}`);
    }
}

/**
 * Execute a transfer from an existing transaction document
 * @param {Object} params
 * @param {string} params.transactionId - Existing transaction document ID
 * @param {Object} params.models - Object containing AccountModel and TransactionModel
 * @returns {Object} Result object
 */
async function executeExistingTransaction({ transactionId, models }) {
    const { AccountModel, TransactionModel } = models;

    try {
        await startTransaction({ transactionId, TransactionModel, AccountModel });
        await applyTransaction({ transactionId, TransactionModel, AccountModel });
        await completeTransaction({ transactionId, TransactionModel, AccountModel });

        return {
            success: true,
            transactionId,
            message: "Transaction completed successfully"
        };
    } catch (error) {
        try {
            await cancelTransaction({ transactionId, TransactionModel, AccountModel });
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError);
        }

        throw new Error(`Transaction failed: ${error.message}`);
    }
}

/**
 * Recover stuck transactions (older than timeout period)
 * @param {Object} params
 * @param {Object} params.models - Object containing AccountModel and TransactionModel
 * @param {number} params.timeoutMinutes - Timeout in minutes (default: 5)
 * @returns {Object} Recovery result
 */
async function recoverStuckTransactions({ models, timeoutMinutes = 5 }) {
    const { TransactionModel, AccountModel } = models;
    const timeout = timeoutMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - timeout);

    const stuckTransactions = await TransactionModel.find({
        state: { $in: ["pending", "applied"] },
        lastModified: { $lt: cutoff }
    });

    const results = [];

    for (const transaction of stuckTransactions) {
        try {
            await cancelTransaction({
                transactionId: transaction._id,
                TransactionModel,
                AccountModel
            });
            results.push({
                transactionId: transaction._id,
                success: true
            });
        } catch (error) {
            results.push({
                transactionId: transaction._id,
                success: false,
                error: error.message
            });
        }
    }

    return {
        recovered: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        details: results
    };
}

/**
 * Get account balance including pending transactions
 * @param {Object} params
 * @param {string} params.accountId - Account ID
 * @param {Object} params.models - Object containing AccountModel and TransactionModel
 * @returns {Object} Balance information
 */
async function getAccountBalance({ accountId, models }) {
    const { AccountModel, TransactionModel } = models;

    const account = await AccountModel.findById(accountId);

    if (!account) {
        throw new Error("Account not found");
    }

    // Calculate pending amount
    const pendingTransactions = await TransactionModel.find({
        _id: { $in: account.pendingTransactions },
        state: { $in: ["pending", "applied"] }
    });

    let pendingDebit = 0;
    let pendingCredit = 0;

    for (const tx of pendingTransactions) {
        if (tx.source.toString() === accountId) {
            pendingDebit += tx.value;
        }
        if (tx.destination.toString() === accountId) {
            pendingCredit += tx.value;
        }
    }

    return {
        accountId,
        balance: account.balance,
        pendingDebit,
        pendingCredit,
        availableBalance: account.balance - pendingDebit,
        projectedBalance: account.balance - pendingDebit + pendingCredit
    };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // High-level API (recommended for most use cases)
    executeTransfer,
    executeExistingTransaction,
    recoverStuckTransactions,
    getAccountBalance,

    // Low-level API (for advanced use cases)
    startTransaction,
    applyTransaction,
    completeTransaction,
    cancelTransaction
};