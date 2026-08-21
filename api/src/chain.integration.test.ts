import { describe, expect, it } from "vitest";
import { algod, generateKeypair, fundNewAccount, USDC_TESTNET_ASA_ID } from "./chain.js";

// Real testnet calls — spends real (test) ALGO/USDC from the dispenser and
// takes several seconds. Run explicitly: `npm run test:integration`.
describe("fundNewAccount (real Algorand testnet)", () => {
  it("funds a freshly generated account with ALGO and opted-in USDC", async () => {
    const { address, sk } = generateKeypair();

    await fundNewAccount(address, sk);

    const info = await algod.accountInformation(address).do();
    expect(Number(info.amount)).toBeGreaterThan(0);

    const holding = info.assets?.find((a) => Number(a.assetId) === USDC_TESTNET_ASA_ID);
    expect(holding).toBeDefined();
    expect(Number(holding?.amount)).toBeGreaterThan(0);
  });
});
