export const BASE_MAINNET_NETWORK = "eip155:8453";
export const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const AUTHORIZATION_CANCELED_TOPIC = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
export const MAX_LOG_SEARCH_BLOCKS = 2000;

export class EvidenceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
}

export async function evidenceFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function terminalReconciliationProjection(evidence) {
  const common = {
    classification: evidence.classification,
    source: evidence.source,
    reasonCode: evidence.reasonCode,
    network: evidence.network,
    asset: evidence.asset,
    authorizationPayer: evidence.payer,
    authorizationNonce: evidence.authorizationNonce,
    transactionReference: evidence.transactionReference,
    blockNumber: evidence.blockNumber,
    ...(evidence.blockHash ? { blockHash: evidence.blockHash } : {}),
    authorizationLogIndex: evidence.authorizationLogIndex,
  };
  if (evidence.classification === "confirmed_paid") {
    return {
      ...common,
      sellerRecipient: evidence.recipient,
      amountAtomic: evidence.amountAtomic,
      transferLogIndex: evidence.transferLogIndex,
    };
  }
  if (evidence.classification === "confirmed_not_paid") return common;
  throw new EvidenceValidationError("Terminal reconciliation fingerprint requires a terminal classification.");
}

export async function terminalReconciliationFingerprint(evidence) {
  return evidenceFingerprint(terminalReconciliationProjection(evidence));
}

export function normalizeAddress(value, label = "Address") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new EvidenceValidationError(`${label} must be a 20-byte EVM address.`);
  return value.toLowerCase();
}

export function normalizeBytes32(value, label = "Bytes32") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new EvidenceValidationError(`${label} must be 32-byte hex.`);
  return value.toLowerCase();
}

export function normalizeAtomic(value, label = "Atomic amount") {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new EvidenceValidationError(`${label} must be a canonical positive integer.`);
  return normalized;
}

function normalizeQuantity(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    const parsed = Number(BigInt(value));
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new EvidenceValidationError(`${label} must be a safe nonnegative JSON-RPC quantity.`);
}

function topicAddress(topic, label) {
  const value = normalizeBytes32(topic, label);
  if (value.slice(2, 26) !== "0".repeat(24)) throw new EvidenceValidationError(`${label} is not an ABI-encoded address.`);
  return `0x${value.slice(-40)}`;
}

function dataUint256(data, label) {
  const value = normalizeBytes32(data, label);
  return BigInt(value).toString();
}

function normalizeExpectedPayment(expected) {
  const network = expected?.network;
  if (network !== BASE_MAINNET_NETWORK) throw new EvidenceValidationError("Payment reconciliation supports Base mainnet only.");
  const asset = normalizeAddress(expected.asset, "Expected asset");
  if (asset !== BASE_MAINNET_USDC) throw new EvidenceValidationError("Expected asset is not Circle native USDC on Base mainnet.");
  return {
    network,
    asset,
    transactionReference: expected.transactionReference ? normalizeBytes32(expected.transactionReference, "Expected transaction") : undefined,
    payer: normalizeAddress(expected.payer, "Expected payer"),
    nonce: normalizeBytes32(expected.nonce, "Expected authorization nonce"),
    recipient: normalizeAddress(expected.recipient, "Expected seller recipient"),
    amountAtomic: normalizeAtomic(expected.amountAtomic),
  };
}

function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") throw new EvidenceValidationError("Receipt must be an object.");
  const transactionHash = normalizeBytes32(receipt.transactionHash, "Receipt transaction hash");
  const blockNumber = normalizeQuantity(receipt.blockNumber, "Receipt block number");
  const blockHash = receipt.blockHash === undefined || receipt.blockHash === null
    ? undefined : normalizeBytes32(receipt.blockHash, "Receipt block hash");
  const success = receipt.status === "0x1" || receipt.status === 1;
  const failed = receipt.status === "0x0" || receipt.status === 0;
  if (!success && !failed) throw new EvidenceValidationError("Receipt status must be explicit success or failure.");
  if (!Array.isArray(receipt.logs)) throw new EvidenceValidationError("Receipt logs must be an array.");
  const logs = receipt.logs.map((log, index) => {
    if (!log || typeof log !== "object" || !Array.isArray(log.topics)) throw new EvidenceValidationError("Receipt log is malformed.");
    return {
      address: normalizeAddress(log.address, "Log address"),
      topics: log.topics.map((topic) => normalizeBytes32(topic, "Log topic")),
      data: typeof log.data === "string" ? log.data.toLowerCase() : "",
      logIndex: log.logIndex === undefined ? index : normalizeQuantity(log.logIndex, "Log index"),
      transactionHash: normalizeBytes32(log.transactionHash, "Log transaction hash"),
    };
  });
  return { transactionHash, blockNumber, blockHash, success, logs };
}

function unresolved(reasonCode, network = BASE_MAINNET_NETWORK) {
  return { classification: "unresolved", source: "base_receipt", reasonCode, network };
}

async function fingerprinted(result) {
  return { ...result, evidenceFingerprint: await evidenceFingerprint(result) };
}

export async function validateKnownPaymentReceipt(expectedInput, receiptInput) {
  const expected = normalizeExpectedPayment(expectedInput);
  const receipt = normalizeReceipt(receiptInput);
  if (expected.transactionReference && receipt.transactionHash !== expected.transactionReference) return fingerprinted(unresolved("transaction_hash_mismatch", expected.network));
  if (!receipt.success) return fingerprinted(unresolved("receipt_failed", expected.network));
  const used = receipt.logs.filter((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3
    && log.topics[0] === AUTHORIZATION_USED_TOPIC
    && topicAddress(log.topics[1], "Authorization authorizer") === expected.payer
    && log.topics[2] === expected.nonce);
  const canceled = receipt.logs.filter((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3
    && log.topics[0] === AUTHORIZATION_CANCELED_TOPIC
    && topicAddress(log.topics[1], "Cancellation authorizer") === expected.payer
    && log.topics[2] === expected.nonce);
  const transfer = receipt.logs.filter((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3
    && log.topics[0] === TRANSFER_TOPIC
    && topicAddress(log.topics[1], "Transfer sender") === expected.payer
    && topicAddress(log.topics[2], "Transfer recipient") === expected.recipient
    && dataUint256(log.data, "Transfer value") === expected.amountAtomic);
  if (canceled.length > 0) return fingerprinted(unresolved("contradictory_authorization_evidence", expected.network));
  if (used.length === 0) return fingerprinted(unresolved("matching_authorization_used_absent", expected.network));
  if (used.length !== 1) return fingerprinted(unresolved("matching_authorization_used_not_unique", expected.network));
  if (transfer.length === 0) return fingerprinted(unresolved("matching_transfer_absent", expected.network));
  if (transfer.length !== 1) return fingerprinted(unresolved("matching_transfer_not_unique", expected.network));
  const normalized = {
    classification: "confirmed_paid",
    source: "base_receipt",
    reasonCode: "matching_authorization_used_and_transfer",
    network: expected.network,
    asset: expected.asset,
    transactionReference: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    ...(receipt.blockHash ? { blockHash: receipt.blockHash } : {}),
    payer: expected.payer,
    authorizationNonce: expected.nonce,
    recipient: expected.recipient,
    amountAtomic: expected.amountAtomic,
    authorizationLogIndex: used[0].logIndex,
    transferLogIndex: transfer[0].logIndex,
  };
  return { ...normalized, evidenceFingerprint: await terminalReconciliationFingerprint(normalized) };
}

export async function validateAuthorizationCancellation(expectedInput, receiptInput) {
  const expected = normalizeExpectedPayment(expectedInput);
  const receipt = normalizeReceipt(receiptInput);
  if (expected.transactionReference && receipt.transactionHash !== expected.transactionReference) return fingerprinted(unresolved("transaction_hash_mismatch", expected.network));
  if (!receipt.success) return fingerprinted(unresolved("cancellation_receipt_failed", expected.network));
  const canceled = receipt.logs.filter((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3
    && log.topics[0] === AUTHORIZATION_CANCELED_TOPIC
    && topicAddress(log.topics[1], "Cancellation authorizer") === expected.payer
    && log.topics[2] === expected.nonce);
  if (canceled.length === 0) return fingerprinted(unresolved("matching_authorization_canceled_absent", expected.network));
  if (canceled.length !== 1) return fingerprinted(unresolved("matching_authorization_canceled_not_unique", expected.network));
  const contradictoryUse = receipt.logs.some((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3 && log.topics[0] === AUTHORIZATION_USED_TOPIC
    && topicAddress(log.topics[1], "Authorization authorizer") === expected.payer
    && log.topics[2] === expected.nonce);
  if (contradictoryUse) return fingerprinted(unresolved("contradictory_authorization_evidence", expected.network));
  const normalized = {
    classification: "confirmed_not_paid",
    source: "base_authorization_cancellation",
    reasonCode: "matching_authorization_canceled",
    network: expected.network,
    asset: expected.asset,
    transactionReference: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    ...(receipt.blockHash ? { blockHash: receipt.blockHash } : {}),
    payer: expected.payer,
    authorizationNonce: expected.nonce,
    authorizationLogIndex: canceled[0].logIndex,
  };
  return { ...normalized, evidenceFingerprint: await terminalReconciliationFingerprint(normalized) };
}

export function classifyAuthorizationState() {
  return unresolved("authorization_state_boolean_is_not_payment_evidence");
}

export async function validateRefundReceipt(expectedInput, receiptInput) {
  if (expectedInput?.network !== BASE_MAINNET_NETWORK) throw new EvidenceValidationError("Refund verification supports Base mainnet only.");
  const asset = normalizeAddress(expectedInput.asset, "Expected refund asset");
  if (asset !== BASE_MAINNET_USDC) throw new EvidenceValidationError("Expected refund asset is not Circle native USDC on Base mainnet.");
  const expected = {
    network: expectedInput.network,
    asset,
    transactionReference: normalizeBytes32(expectedInput.transactionReference, "Expected refund transaction"),
    payer: normalizeAddress(expectedInput.payer, "Expected refund source"),
    recipient: normalizeAddress(expectedInput.recipient, "Trusted refund recipient"),
    amountAtomic: normalizeAtomic(expectedInput.amountAtomic, "Expected refund amount"),
  };
  const receipt = normalizeReceipt(receiptInput);
  if (receipt.transactionHash !== expected.transactionReference) return fingerprinted({ outcome: "unresolved", source: "base_receipt", reasonCode: "transaction_hash_mismatch" });
  if (!receipt.success) {
    const normalized = {
      outcome: "failed", source: "base_receipt", reasonCode: "refund_receipt_failed", network: expected.network, asset: expected.asset,
      transactionReference: receipt.transactionHash, blockNumber: receipt.blockNumber,
      payer: expected.payer, recipient: expected.recipient, amountAtomic: expected.amountAtomic,
    };
    return { ...normalized, evidenceFingerprint: await evidenceFingerprint(normalized) };
  }
  const transfer = receipt.logs.filter((log) => log.transactionHash === receipt.transactionHash
    && log.address === expected.asset
    && log.topics.length >= 3 && log.topics[0] === TRANSFER_TOPIC
    && topicAddress(log.topics[1], "Refund sender") === expected.payer
    && topicAddress(log.topics[2], "Refund recipient") === expected.recipient
    && dataUint256(log.data, "Refund value") === expected.amountAtomic);
  if (transfer.length === 0) return fingerprinted({ outcome: "unresolved", source: "base_receipt", reasonCode: "matching_refund_transfer_absent", network: expected.network });
  if (transfer.length !== 1) return fingerprinted({ outcome: "unresolved", source: "base_receipt", reasonCode: "matching_refund_transfer_not_unique", network: expected.network });
  const normalized = {
    outcome: "confirmed", source: "base_receipt", reasonCode: "matching_refund_transfer", network: expected.network,
    asset: expected.asset, transactionReference: receipt.transactionHash, blockNumber: receipt.blockNumber,
    ...(receipt.blockHash ? { blockHash: receipt.blockHash } : {}), payer: expected.payer,
    recipient: expected.recipient, amountAtomic: expected.amountAtomic, transferLogIndex: transfer[0].logIndex,
  };
  return { ...normalized, evidenceFingerprint: await evidenceFingerprint(normalized) };
}

export function validateBlockRange(fromBlock, toBlock) {
  const from = normalizeQuantity(fromBlock, "From block");
  const to = normalizeQuantity(toBlock, "To block");
  if (to < from) throw new EvidenceValidationError("To block must be at or after from block.");
  if (to - from + 1 > MAX_LOG_SEARCH_BLOCKS) throw new EvidenceValidationError(`Block range must not exceed ${MAX_LOG_SEARCH_BLOCKS} blocks.`);
  return { fromBlock: from, toBlock: to };
}

export function authorizationSearchTopics(expectedInput) {
  const expected = normalizeExpectedPayment(expectedInput);
  return {
    address: expected.asset,
    fromTopic: `0x${"0".repeat(24)}${expected.payer.slice(2)}`,
    nonceTopic: expected.nonce,
    usedTopic: AUTHORIZATION_USED_TOPIC,
    canceledTopic: AUTHORIZATION_CANCELED_TOPIC,
  };
}

export async function investigateAuthorizationLogs(expectedInput, logs, receiptLookup) {
  const expected = normalizeExpectedPayment(expectedInput);
  if (!Array.isArray(logs)) throw new EvidenceValidationError("Authorization search logs must be an array.");
  if (typeof receiptLookup !== "function") throw new EvidenceValidationError("Receipt lookup function is required.");
  for (const log of logs) {
    if (!log || typeof log !== "object" || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    const address = normalizeAddress(log.address, "Search log address");
    const topic0 = normalizeBytes32(log.topics[0], "Search event topic");
    const payer = topicAddress(log.topics[1], "Search authorization payer");
    const nonce = normalizeBytes32(log.topics[2], "Search authorization nonce");
    if (address !== expected.asset || payer !== expected.payer || nonce !== expected.nonce) continue;
    if (topic0 !== AUTHORIZATION_USED_TOPIC && topic0 !== AUTHORIZATION_CANCELED_TOPIC) continue;
    const transactionReference = normalizeBytes32(log.transactionHash, "Search transaction hash");
    const receipt = await receiptLookup(transactionReference);
    if (!receipt) continue;
    if (topic0 === AUTHORIZATION_USED_TOPIC) {
      const positive = await validateKnownPaymentReceipt({ ...expected, transactionReference }, receipt);
      if (positive.classification === "confirmed_paid") return positive;
    } else {
      const negative = await validateAuthorizationCancellation({ ...expected, transactionReference }, receipt);
      if (negative.classification === "confirmed_not_paid") return negative;
    }
  }
  return fingerprinted({ classification: "unresolved", source: "base_log_search", reasonCode: "no_validated_authorization_evidence", network: expected.network });
}
