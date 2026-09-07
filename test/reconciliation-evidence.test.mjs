import { describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_USED_TOPIC,
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  TRANSFER_TOPIC,
  classifyAuthorizationState,
  evidenceFingerprint,
  investigateAuthorizationLogs,
  terminalReconciliationFingerprint,
  terminalReconciliationProjection,
  validateAuthorizationCancellation,
  validateBlockRange,
  validateKnownPaymentReceipt,
  validateRefundReceipt,
} from "../scripts/reconciliation-evidence.mjs";
import { deriveTerminalReconciliationFingerprint } from "../src/remediation";

const payer = `0x${"11".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;
const nonce = `0x${"33".repeat(32)}`;
const transaction = `0x${"44".repeat(32)}`;
const otherTransaction = `0x${"45".repeat(32)}`;
const blockHash = `0x${"55".repeat(32)}`;
const amount = "50000";

const topicAddress = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const uint256 = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const expected = {
  network: BASE_MAINNET_NETWORK,
  asset: BASE_MAINNET_USDC,
  transactionReference: transaction,
  payer,
  nonce,
  recipient,
  amountAtomic: amount,
};
const usedLog = (overrides = {}) => ({
  address: BASE_MAINNET_USDC,
  topics: [AUTHORIZATION_USED_TOPIC, topicAddress(payer), nonce],
  data: "0x",
  logIndex: "0x1",
  transactionHash: transaction,
  ...overrides,
});
const canceledLog = (overrides = {}) => ({
  address: BASE_MAINNET_USDC,
  topics: [AUTHORIZATION_CANCELED_TOPIC, topicAddress(payer), nonce],
  data: "0x",
  logIndex: "0x1",
  transactionHash: transaction,
  ...overrides,
});
const transferLog = (overrides = {}) => ({
  address: BASE_MAINNET_USDC,
  topics: [TRANSFER_TOPIC, topicAddress(payer), topicAddress(recipient)],
  data: uint256(amount),
  logIndex: "0x2",
  transactionHash: transaction,
  ...overrides,
});
const receipt = (logs = [usedLog(), transferLog()], overrides = {}) => ({
  transactionHash: transaction,
  status: "0x1",
  blockNumber: "0x64",
  blockHash,
  logs,
  ...overrides,
});

describe("offline reconciliation evidence", () => {
  it("confirms payment only from a successful expected-USDC receipt with matching AuthorizationUsed and Transfer", async () => {
    const result = await validateKnownPaymentReceipt(expected, receipt());
    expect(result).toMatchObject({
      classification: "confirmed_paid",
      payer,
      recipient,
      amountAtomic: amount,
      authorizationNonce: nonce,
      transactionReference: transaction,
      blockNumber: 100,
    });
    expect(result.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["failed receipt", receipt(undefined, { status: "0x0" }), "receipt_failed"],
    ["wrong contract", receipt([usedLog({ address: `0x${"99".repeat(20)}` }), transferLog()]), "matching_authorization_used_absent"],
    ["wrong payer", receipt([usedLog({ topics: [AUTHORIZATION_USED_TOPIC, topicAddress(`0x${"99".repeat(20)}`), nonce] }), transferLog()]), "matching_authorization_used_absent"],
    ["wrong nonce", receipt([usedLog({ topics: [AUTHORIZATION_USED_TOPIC, topicAddress(payer), `0x${"99".repeat(32)}`] }), transferLog()]), "matching_authorization_used_absent"],
    ["wrong recipient", receipt([usedLog(), transferLog({ topics: [TRANSFER_TOPIC, topicAddress(payer), topicAddress(`0x${"99".repeat(20)}`)] })]), "matching_transfer_absent"],
    ["wrong amount", receipt([usedLog(), transferLog({ data: uint256("50001") })]), "matching_transfer_absent"],
    ["used only", receipt([usedLog()]), "matching_transfer_absent"],
    ["transfer only", receipt([transferLog()]), "matching_authorization_used_absent"],
    ["success alone", receipt([]), "matching_authorization_used_absent"],
  ])("does not confirm payment from %s", async (_label, candidate, reasonCode) => {
    const result = await validateKnownPaymentReceipt(expected, candidate);
    expect(result).toMatchObject({ classification: "unresolved", reasonCode });
    expect(result.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed addresses, nonces, and atomic amounts", async () => {
    await expect(validateKnownPaymentReceipt({ ...expected, payer: "0x1234" }, receipt())).rejects.toThrow(/address/i);
    await expect(validateKnownPaymentReceipt({ ...expected, nonce: "0x12" }, receipt())).rejects.toThrow(/32-byte/i);
    await expect(validateKnownPaymentReceipt({ ...expected, amountAtomic: "050000" }, receipt())).rejects.toThrow(/canonical/i);
  });

  it("accepts only a successful matching AuthorizationCanceled event as automated nonpayment evidence", async () => {
    const valid = await validateAuthorizationCancellation(expected, receipt([canceledLog()]));
    expect(valid).toMatchObject({ classification: "confirmed_not_paid", payer, authorizationNonce: nonce, transactionReference: transaction });
    await expect(validateAuthorizationCancellation(expected, receipt([]))).resolves.toMatchObject({ classification: "unresolved" });
    await expect(validateAuthorizationCancellation(expected, receipt([canceledLog({ address: `0x${"99".repeat(20)}` })]))).resolves.toMatchObject({ classification: "unresolved" });
    await expect(validateAuthorizationCancellation(expected, receipt([canceledLog(), usedLog()]))).resolves.toMatchObject({
      classification: "unresolved", reasonCode: "contradictory_authorization_evidence",
    });
    expect(classifyAuthorizationState(true)).toMatchObject({ classification: "unresolved" });
    expect(classifyAuthorizationState(false)).toMatchObject({ classification: "unresolved" });
  });

  it("binds every used receipt log to the receipt transaction and fails closed on missing or malformed hashes", async () => {
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog({ transactionHash: otherTransaction }), transferLog(),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_authorization_used_absent" });
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog(), transferLog({ transactionHash: otherTransaction }),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_transfer_absent" });
    await expect(validateAuthorizationCancellation(expected, receipt([
      canceledLog({ transactionHash: otherTransaction }),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_authorization_canceled_absent" });
    await expect(validateRefundReceipt({
      network: BASE_MAINNET_NETWORK, asset: BASE_MAINNET_USDC, transactionReference: transaction,
      payer, recipient, amountAtomic: amount,
    }, receipt([transferLog({ transactionHash: otherTransaction })]))).resolves.toMatchObject({
      outcome: "unresolved", reasonCode: "matching_refund_transfer_absent",
    });
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog({ transactionHash: undefined }), transferLog(),
    ]))).rejects.toThrow(/transaction hash/i);
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog({ transactionHash: "0x1234" }), transferLog(),
    ]))).rejects.toThrow(/transaction hash/i);
  });

  it("requires unique noncontradictory exact-payment and cancellation evidence while permitting unrelated logs", async () => {
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog(), usedLog({ logIndex: "0x3" }), transferLog(),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_authorization_used_not_unique" });
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog(), transferLog(), transferLog({ logIndex: "0x3" }),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_transfer_not_unique" });
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog(), canceledLog(), transferLog(),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "contradictory_authorization_evidence" });
    await expect(validateAuthorizationCancellation(expected, receipt([
      canceledLog(), canceledLog({ logIndex: "0x3" }),
    ]))).resolves.toMatchObject({ classification: "unresolved", reasonCode: "matching_authorization_canceled_not_unique" });
    await expect(validateKnownPaymentReceipt(expected, receipt([
      usedLog(), transferLog(), transferLog({
        topics: [TRANSFER_TOPIC, topicAddress(payer), topicAddress(`0x${"99".repeat(20)}`)],
        logIndex: "0x3",
      }),
    ]))).resolves.toMatchObject({ classification: "confirmed_paid" });
  });

  it("requires explicit bounded search ranges and fully validates candidate receipts", async () => {
    expect(validateBlockRange(100, 2099)).toEqual({ fromBlock: 100, toBlock: 2099 });
    expect(() => validateBlockRange(100, 2100)).toThrow(/2000/);
    const lookup = vi.fn(async () => receipt());
    await expect(investigateAuthorizationLogs(expected, [usedLog()], lookup)).resolves.toMatchObject({
      classification: "confirmed_paid", authorizationNonce: nonce,
    });
    expect(lookup).toHaveBeenCalledOnce();
    await expect(investigateAuthorizationLogs(expected, [], vi.fn())).resolves.toMatchObject({ classification: "unresolved" });
  });

  it("verifies an exact trusted-recipient refund and distinguishes failed or unconfirmed receipts", async () => {
    const refundExpected = {
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      transactionReference: transaction,
      payer,
      recipient,
      amountAtomic: amount,
    };
    await expect(validateRefundReceipt(refundExpected, receipt([transferLog()]))).resolves.toMatchObject({ outcome: "confirmed" });
    await expect(validateRefundReceipt(refundExpected, receipt([], { status: "0x0" }))).resolves.toMatchObject({ outcome: "failed" });
    await expect(validateRefundReceipt(refundExpected, receipt([]))).resolves.toMatchObject({ outcome: "unresolved" });
    await expect(validateRefundReceipt({ ...refundExpected, amountAtomic: "49999" }, receipt([transferLog()]))).resolves.toMatchObject({ outcome: "unresolved" });
    await expect(validateRefundReceipt({ ...refundExpected, recipient: `0x${"99".repeat(20)}` }, receipt([transferLog()]))).resolves.toMatchObject({ outcome: "unresolved" });
    await expect(validateRefundReceipt(refundExpected, receipt([
      transferLog(), transferLog({ logIndex: "0x3" }),
    ]))).resolves.toMatchObject({ outcome: "unresolved", reasonCode: "matching_refund_transfer_not_unique" });
  });

  it("produces a deterministic normalized fingerprint without retaining a raw RPC body", async () => {
    const left = await evidenceFingerprint({ b: 2, a: { d: 4, c: 3 } });
    const right = await evidenceFingerprint({ a: { c: 3, d: 4 }, b: 2 });
    expect(left).toBe(right);
    expect(await evidenceFingerprint({ authorizationNonce: nonce })).not.toBe(
      await evidenceFingerprint({ authorizationNonce: `0x${"34".repeat(32)}` }),
    );
    expect(JSON.stringify(await validateKnownPaymentReceipt(expected, receipt()))).not.toContain("raw");
  });

  it("binds terminal fingerprints to the canonical normalized evidence projection", async () => {
    const paid = await validateKnownPaymentReceipt(expected, receipt());
    const cancellation = await validateAuthorizationCancellation(expected, receipt([canceledLog()]));
    const otherPayer = `0x${"66".repeat(20)}`;
    const otherAmount = "50001";
    const otherTransactionPaid = await validateKnownPaymentReceipt({
      ...expected,
      transactionReference: otherTransaction,
    }, receipt([
      usedLog({ transactionHash: otherTransaction }),
      transferLog({ transactionHash: otherTransaction }),
    ], { transactionHash: otherTransaction }));
    const otherPayerPaid = await validateKnownPaymentReceipt({ ...expected, payer: otherPayer }, receipt([
      usedLog({ topics: [AUTHORIZATION_USED_TOPIC, topicAddress(otherPayer), nonce] }),
      transferLog({ topics: [TRANSFER_TOPIC, topicAddress(otherPayer), topicAddress(recipient)] }),
    ]));
    const otherAmountPaid = await validateKnownPaymentReceipt({ ...expected, amountAtomic: otherAmount }, receipt([
      usedLog(), transferLog({ data: uint256(otherAmount) }),
    ]));
    const uppercasePaid = await validateKnownPaymentReceipt({
      ...expected,
      asset: expected.asset.toUpperCase().replace("0X", "0x"),
      transactionReference: expected.transactionReference.toUpperCase().replace("0X", "0x"),
      payer: expected.payer.toUpperCase().replace("0X", "0x"),
      nonce: expected.nonce.toUpperCase().replace("0X", "0x"),
      recipient: expected.recipient.toUpperCase().replace("0X", "0x"),
    }, receipt());

    expect(paid.evidenceFingerprint).toBe(await terminalReconciliationFingerprint(paid));
    expect(paid.evidenceFingerprint).toBe(await deriveTerminalReconciliationFingerprint(paid));
    expect(cancellation.evidenceFingerprint).toBe(await deriveTerminalReconciliationFingerprint(cancellation));
    expect(paid.evidenceFingerprint).toBe("7af53580d1550a5f8e6fdd86780d480fabbd66e54120569653c1259b4e459894");
    expect(cancellation.evidenceFingerprint).toBe("f5232c2e87eaaab7bba9f2abb906840f04378520ccea0d6c06686f76f42dce2d");
    expect(otherTransactionPaid.evidenceFingerprint).not.toBe(paid.evidenceFingerprint);
    expect(otherPayerPaid.evidenceFingerprint).not.toBe(paid.evidenceFingerprint);
    expect(otherAmountPaid.evidenceFingerprint).not.toBe(paid.evidenceFingerprint);
    expect(cancellation.evidenceFingerprint).not.toBe(paid.evidenceFingerprint);
    expect(await evidenceFingerprint({
      ...terminalReconciliationProjection(paid),
      classification: "confirmed_not_paid",
    })).not.toBe(paid.evidenceFingerprint);
    expect(uppercasePaid.evidenceFingerprint).toBe(paid.evidenceFingerprint);
  });
});
