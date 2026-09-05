export interface VerifyResult {
  valid:    boolean;
  reason?:  string;  // human-readable failure description when valid === false
}

// SettleResult is reserved for Phase 2
export interface SettleResult {
  txid: string;
}
