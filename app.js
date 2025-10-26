const mongoose = require("mongoose");
const {ok} = require("node:assert");
const {executeTransfer} = require("./towPhaseComments");

// conect to Database
mongoose.connect("mongodb://localhost:27017/two-phase-commits?replicaSet=rs0").then(() => console.log("Connected to MongoDB ....")).catch(err => console.error("Error in connecting to Database", err));

//region create Account model
const AccountModel = mongoose.model("Account", new mongoose.Schema({
    firstName: String,
    lastName: String,
    balance: Number,
    pendingTransactions: [String]
}));
// endregion

//region create transactions model
const TransactionModel = mongoose.model("Transactions", new mongoose.Schema({
    source: {
        type: mongoose.Schema.ObjectId,
        ref: "Account"
    },

    destination: {
        type: mongoose.Schema.ObjectId,
        ref: "Account"
    },

    value: Number,
    state: {
        type: String,
        enum: ["initial", "pending", "applied", "done", "canceling", "canceled"]
    },
    lastModified: {type: Date, default: Date.now},
}))
// endregion

// region create sample from Account
const createAccount = async () => {
    const account = new AccountModel({firstName: "amir", lastName: "ranjbar", balance: 2500, pendingTransactions: []});

    await account.save();
};
// endregion

// region create sample from Transaction
const createTransaction = async ()=>{

    const transaction = new TransactionModel({
        source:"68fda6a949c675643631a6ce",
        destination:"68fda6012b32a0b4d1c01328",
        value:500,
        state:"initial"
    });

    await transaction.save();

};
// endregion



// *********************************************************************
//createAccount()
//createTransaction()

// *********************************************************************
const startTransaction = async ({sourceId, destId , amount})=>{

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        await AccountModel.updateOne(
            { _id: sourceId },
            { $inc: { balance: -amount } },
            { session }
        );

        await AccountModel.updateOne(
            { _id: destId },
            { $inc: { balance: amount } },
            { session }
        );

        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }



};

// startTransaction({sourceId:"68fda6a949c675643631a6ce" ,
//     destId:"68fda6012b32a0b4d1c01328" , amount:500});

// **********************************************************************************************
// Example 1: Simple transfer
async function simpleTransfer() {
    try {
        const result = await executeTransfer({
            sourceId: "68fda6a949c675643631a6ce",
            destId: "68fda6012b32a0b4d1c01328",
            amount: 500,
            models: { AccountModel, TransactionModel }
        });

        console.log("Success:", result);
    } catch (error) {
        console.error("Transfer failed:", error.message);
    }
}

simpleTransfer()