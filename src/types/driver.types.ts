export interface VerifyResult {
  valid:    boolean;
  reason?:  string;  // human-readable failure description when valid === false
}

export interface SettleResult {
  txid:    string;
  status:  'submitted' | 'confirmed' | 'failed';
}
