// verification-contract.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface VerificationEntry {
  status: string;
  validatorVotes: string[];
  rejectVotes: string[];
  oracleDataHash: string | null;
  reductionPercent: number;
  voteStartBlock: number;
  metadata: string;
  disputeId: number | null;
}

interface DisputeEntry {
  reportId: number;
  challenger: string;
  evidenceHash: string;
  resolverVotes: string[];
  startBlock: number;
  resolved: boolean;
  outcome: boolean | null;
}

interface ValidatorEntry {
  active: boolean;
  voteWeight: number;
  totalVotesCast: number;
  successfulVerifications: number;
}

interface ContractState {
  verifications: Map<number, VerificationEntry>;
  disputes: Map<number, DisputeEntry>;
  validators: Map<string, ValidatorEntry>;
  configs: Map<string, number>;
  blockHeight: number;
  disputeCounter: number;
}

// Mock contract implementation
class VerificationContractMock {
  private state: ContractState = {
    verifications: new Map(),
    disputes: new Map(),
    validators: new Map(),
    configs: new Map([
      ["verification-threshold", 3],
      ["dispute-threshold", 2],
    ]),
    blockHeight: 1000,
    disputeCounter: 0,
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_REPORT = 101;
  private ERR_ALREADY_VERIFIED = 102;
  private ERR_INSUFFICIENT_VOTES = 103;
  private ERR_DISPUTE_EXPIRED = 104;
  private ERR_INVALID_THRESHOLD = 105;
  private ERR_ORACLE_FAILURE = 106;
  private ERR_INVALID_STATE = 107;
  private ERR_METADATA_TOO_LONG = 108;
  private ERR_INVALID_VOTE = 109;
  private ERR_DUPLICATE_VOTE = 110;
  private ERR_DISPUTE_NOT_FOUND = 111;
  private ERR_REPORT_EXPIRED = 112;
  private ERR_INVALID_CALCULATION = 113;

  private MIN_REDUCTION_PERCENT = 20;
  private MAX_METADATA_LEN = 1000;
  private DISPUTE_WINDOW = 144;
  private VOTE_YES = 1;
  private VOTE_NO = 2;

  // Simulate block height increase
  advanceBlock(blocks: number = 1): void {
    this.state.blockHeight += blocks;
  }

  registerValidator(caller: string, weight: number): ClarityResponse<boolean> {
    if (weight <= 0) {
      return { ok: false, value: this.ERR_INVALID_THRESHOLD };
    }
    // Assume authorized for mock
    this.state.validators.set(caller, {
      active: true,
      voteWeight: weight,
      totalVotesCast: 0,
      successfulVerifications: 0,
    });
    return { ok: true, value: true };
  }

  submitVerificationRequest(caller: string, reportId: number, baselineWaste: number, currentWaste: number, metadata: string): ClarityResponse<boolean> {
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_METADATA_TOO_LONG };
    }
    if (this.state.verifications.has(reportId)) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }
    const reduction = this.calculateReductionPercent(baselineWaste, currentWaste);
    if (reduction < this.MIN_REDUCTION_PERCENT) {
      return { ok: false, value: this.ERR_INVALID_CALCULATION };
    }
    this.state.verifications.set(reportId, {
      status: "pending",
      validatorVotes: [],
      rejectVotes: [],
      oracleDataHash: null,
      reductionPercent: reduction,
      voteStartBlock: this.state.blockHeight,
      metadata,
      disputeId: null,
    });
    return { ok: true, value: true };
  }

  integrateOracleData(caller: string, reportId: number, dataHash: string): ClarityResponse<boolean> {
    const verification = this.state.verifications.get(reportId);
    if (!verification) {
      return { ok: false, value: this.ERR_INVALID_REPORT };
    }
    if (verification.status !== "pending") {
      return { ok: false, value: this.ERR_INVALID_STATE };
    }
    // Assume caller is oracle
    verification.oracleDataHash = dataHash;
    return { ok: true, value: true };
  }

  voteOnVerification(caller: string, reportId: number, vote: number): ClarityResponse<string> {
    const verification = this.state.verifications.get(reportId);
    if (!verification) {
      return { ok: false, value: this.ERR_INVALID_REPORT };
    }
    if (![this.VOTE_YES, this.VOTE_NO].includes(vote)) {
      return { ok: false, value: this.ERR_INVALID_VOTE };
    }
    if (!this.state.validators.has(caller) || !this.state.validators.get(caller)!.active) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (verification.status !== "pending") {
      return { ok: false, value: this.ERR_INVALID_STATE };
    }
    if (this.state.blockHeight - verification.voteStartBlock >= this.DISPUTE_WINDOW) {
      return { ok: false, value: this.ERR_REPORT_EXPIRED };
    }
    if (verification.validatorVotes.includes(caller) || verification.rejectVotes.includes(caller)) {
      return { ok: false, value: this.ERR_DUPLICATE_VOTE };
    }
    if (vote === this.VOTE_YES) {
      verification.validatorVotes.push(caller);
    } else {
      verification.rejectVotes.push(caller);
    }
    const validator = this.state.validators.get(caller)!;
    validator.totalVotesCast += 1;

    const tallies = this.tallyVotes(reportId);
    if (tallies.yes >= tallies.required) {
      verification.status = "verified";
      return { ok: true, value: "verified" };
    } else if (tallies.no >= tallies.required) {
      verification.status = "rejected";
      return { ok: true, value: "rejected" };
    }
    return { ok: true, value: "voted" };
  }

  initiateDispute(caller: string, reportId: number, evidenceHash: string): ClarityResponse<number> {
    const verification = this.state.verifications.get(reportId);
    if (!verification) {
      return { ok: false, value: this.ERR_INVALID_REPORT };
    }
    if (verification.status !== "verified") {
      return { ok: false, value: this.ERR_INVALID_STATE };
    }
    if (this.state.blockHeight - verification.voteStartBlock >= this.DISPUTE_WINDOW) {
      return { ok: false, value: this.ERR_DISPUTE_EXPIRED };
    }
    this.state.disputeCounter += 1;
    const disputeId = this.state.disputeCounter;
    this.state.disputes.set(disputeId, {
      reportId,
      challenger: caller,
      evidenceHash,
      resolverVotes: [],
      startBlock: this.state.blockHeight,
      resolved: false,
      outcome: null,
    });
    verification.status = "disputed";
    verification.disputeId = disputeId;
    return { ok: true, value: disputeId };
  }

  voteOnDispute(caller: string, disputeId: number, uphold: boolean): ClarityResponse<string> {
    const dispute = this.state.disputes.get(disputeId);
    if (!dispute) {
      return { ok: false, value: this.ERR_DISPUTE_NOT_FOUND };
    }
    if (dispute.resolved) {
      return { ok: false, value: this.ERR_INVALID_STATE };
    }
    if (!this.state.validators.has(caller) || !this.state.validators.get(caller)!.active) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (dispute.resolverVotes.includes(caller)) {
      return { ok: false, value: this.ERR_DUPLICATE_VOTE };
    }
    dispute.resolverVotes.push(caller);
    const requiredVotes = this.state.configs.get("dispute-threshold")!;
    if (dispute.resolverVotes.length >= requiredVotes) {
      dispute.resolved = true;
      dispute.outcome = uphold; // Mock simple outcome
      const verification = this.state.verifications.get(dispute.reportId)!;
      verification.status = uphold ? "rejected" : "verified";
      verification.disputeId = null;
      return { ok: true, value: "resolved" };
    }
    return { ok: true, value: "voted" };
  }

  updateConfig(caller: string, key: string, value: number): ClarityResponse<boolean> {
    // Assume authorized
    if (value <= 0) {
      return { ok: false, value: this.ERR_INVALID_THRESHOLD };
    }
    this.state.configs.set(key, value);
    return { ok: true, value: true };
  }

  getVerificationDetails(reportId: number): ClarityResponse<VerificationEntry | null> {
    return { ok: true, value: this.state.verifications.get(reportId) ?? null };
  }

  getDisputeDetails(disputeId: number): ClarityResponse<DisputeEntry | null> {
    return { ok: true, value: this.state.disputes.get(disputeId) ?? null };
  }

  getValidatorInfo(validator: string): ClarityResponse<ValidatorEntry | null> {
    return { ok: true, value: this.state.validators.get(validator) ?? null };
  }

  getConfigValue(key: string): ClarityResponse<number> {
    return { ok: true, value: this.state.configs.get(key) ?? 0 };
  }

  previewReductionPercent(baseline: number, current: number): ClarityResponse<number> {
    return { ok: true, value: this.calculateReductionPercent(baseline, current) };
  }

  hasMetThreshold(reportId: number): ClarityResponse<boolean> {
    const tallies = this.tallyVotes(reportId);
    return { ok: true, value: tallies.yes >= tallies.required };
  }

  private calculateReductionPercent(baseline: number, current: number): number {
    if (current >= baseline) return 0;
    return Math.floor((100 * (baseline - current)) / baseline);
  }

  private tallyVotes(reportId: number): { yes: number; no: number; required: number } {
    const verification = this.state.verifications.get(reportId)!;
    return {
      yes: verification.validatorVotes.length,
      no: verification.rejectVotes.length,
      required: this.state.configs.get("verification-threshold")!,
    };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  manufacturer: "manufacturer",
  validator1: "validator1",
  validator2: "validator2",
  validator3: "validator3",
  oracle: "oracle",
  challenger: "challenger",
};

describe("VerificationContract", () => {
  let contract: VerificationContractMock;

  beforeEach(() => {
    contract = new VerificationContractMock();
    vi.resetAllMocks();
    // Register validators
    contract.registerValidator(accounts.validator1, 1);
    contract.registerValidator(accounts.validator2, 1);
    contract.registerValidator(accounts.validator3, 1);
  });

  it("should register a validator correctly", () => {
    const result = contract.registerValidator(accounts.validator1, 1);
    expect(result).toEqual({ ok: true, value: true });
    const info = contract.getValidatorInfo(accounts.validator1);
    expect(info).toEqual({
      ok: true,
      value: expect.objectContaining({ active: true, voteWeight: 1 }),
    });
  });

  it("should prevent invalid weight in validator registration", () => {
    const result = contract.registerValidator(accounts.validator1, 0);
    expect(result).toEqual({ ok: false, value: 105 });
  });

  it("should submit a verification request successfully", () => {
    const result = contract.submitVerificationRequest(
      accounts.manufacturer,
      1,
      1000,
      700,
      "Test metadata"
    );
    expect(result).toEqual({ ok: true, value: true });
    const details = contract.getVerificationDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "pending", reductionPercent: 30 }),
    });
  });

  it("should reject submission with insufficient reduction", () => {
    const result = contract.submitVerificationRequest(
      accounts.manufacturer,
      1,
      1000,
      900,
      "Test"
    );
    expect(result).toEqual({ ok: false, value: 113 });
  });

  it("should integrate oracle data", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    const result = contract.integrateOracleData(accounts.oracle, 1, "hash123");
    expect(result).toEqual({ ok: true, value: true });
    const details = contract.getVerificationDetails(1);
    expect(details.value?.oracleDataHash).toBe("hash123");
  });

  it("should allow validators to vote and verify report", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    contract.voteOnVerification(accounts.validator1, 1, 1);
    contract.voteOnVerification(accounts.validator2, 1, 1);
    const partial = contract.voteOnVerification(accounts.validator3, 1, 1);
    expect(partial).toEqual({ ok: true, value: "verified" });
    const details = contract.getVerificationDetails(1);
    expect(details.value?.status).toBe("verified");
  });

  it("should prevent duplicate votes", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    contract.voteOnVerification(accounts.validator1, 1, 1);
    const duplicate = contract.voteOnVerification(accounts.validator1, 1, 1);
    expect(duplicate).toEqual({ ok: false, value: 110 });
  });

  it("should initiate and resolve a dispute", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    contract.voteOnVerification(accounts.validator1, 1, 1);
    contract.voteOnVerification(accounts.validator2, 1, 1);
    contract.voteOnVerification(accounts.validator3, 1, 1);
    const disputeResult = contract.initiateDispute(accounts.challenger, 1, "evidenceHash");
    expect(disputeResult.ok).toBe(true);
    const disputeId = disputeResult.value as number;
    contract.voteOnDispute(accounts.validator1, disputeId, true);
    const resolve = contract.voteOnDispute(accounts.validator2, disputeId, true);
    expect(resolve).toEqual({ ok: true, value: "resolved" });
    const details = contract.getVerificationDetails(1);
    expect(details.value?.status).toBe("rejected");
  });

  it("should expire dispute window", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    contract.voteOnVerification(accounts.validator1, 1, 1);
    contract.voteOnVerification(accounts.validator2, 1, 1);
    contract.voteOnVerification(accounts.validator3, 1, 1);
    contract.advanceBlock(145);
    const disputeResult = contract.initiateDispute(accounts.challenger, 1, "evidenceHash");
    expect(disputeResult).toEqual({ ok: false, value: 104 });
  });

  it("should update config values", () => {
    const result = contract.updateConfig(accounts.deployer, "verification-threshold", 4);
    expect(result).toEqual({ ok: true, value: true });
    const value = contract.getConfigValue("verification-threshold");
    expect(value).toEqual({ ok: true, value: 4 });
  });

  it("should preview reduction percent correctly", () => {
    const result = contract.previewReductionPercent(1000, 700);
    expect(result).toEqual({ ok: true, value: 30 });
  });

  it("should check if threshold is met", () => {
    contract.submitVerificationRequest(accounts.manufacturer, 1, 1000, 700, "Test");
    contract.voteOnVerification(accounts.validator1, 1, 1);
    contract.voteOnVerification(accounts.validator2, 1, 1);
    const notMet = contract.hasMetThreshold(1);
    expect(notMet).toEqual({ ok: true, value: false });
    contract.voteOnVerification(accounts.validator3, 1, 1);
    const met = contract.hasMetThreshold(1);
    expect(met).toEqual({ ok: true, value: true });
  });
});