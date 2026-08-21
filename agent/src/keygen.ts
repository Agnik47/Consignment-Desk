import algosdk from "algosdk";

// One-off Phase 1 utility: generate a fresh Algorand testnet keypair and print
// it in the shapes the rest of the stack expects — address for AVM_ADDRESS,
// base64 secret key for AVM_PRIVATE_KEY (toClientAvmSigner's expected format).
// Not wired into the app; Phase 2 replaces this with server-side session-bound
// generation per AGENTS.md.
const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

console.log("address:   ", account.addr.toString());
console.log("secretKey: ", Buffer.from(account.sk).toString("base64"));
console.log("mnemonic:  ", mnemonic);
console.log("\nFund this address at https://bank.testnet.algorand.network/ or via `algokit dispenser fund`.");
