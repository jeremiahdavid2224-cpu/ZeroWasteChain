;; verification-contract.clar
;; Verification Contract for ZeroWasteChain
;; This contract handles the verification of waste reduction reports submitted by manufacturers.
;; It integrates with oracles for external data validation, allows validators to vote on reports,
;; supports dispute resolution, and determines if reductions meet reward thresholds.
;; Thresholds are configurable via governance (assumed to be in GovernanceContract).
;; Assumes interactions with ReportingContract for report data, OracleContract for external proofs,
;; and RewardDistributionContract for triggering rewards upon successful verification.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-REPORT u101)
(define-constant ERR-ALREADY-VERIFIED u102)
(define-constant ERR-INSUFFICIENT-VOTES u103)
(define-constant ERR-DISPUTE-EXPIRED u104)
(define-constant ERR-INVALID-THRESHOLD u105)
(define-constant ERR-ORACLE-FAILURE u106)
(define-constant ERR-INVALID-STATE u107)
(define-constant ERR-METADATA-TOO-LONG u108)
(define-constant ERR-INVALID-VOTE u109)
(define-constant ERR-DUPLICATE-VOTE u110)
(define-constant ERR-DISPUTE-NOT-FOUND u111)
(define-constant ERR-REPORT-EXPIRED u112)
(define-constant ERR-INVALID-CALCULATION u113)

(define-constant VERIFICATION_THRESHOLD u3) ;; Minimum validator votes needed (configurable later)
(define-constant DISPUTE_WINDOW u144) ;; Blocks for dispute period (~1 day on Stacks)
(define-constant MIN_REDUCTION_PERCENT u20) ;; Minimum % waste reduction for rewards
(define-constant MAX_METADATA_LEN u1000) ;; Max length for verification metadata
(define-constant VOTE_YES u1)
(define-constant VOTE_NO u2)

;; Data Maps
;; Verification requests: Keyed by report-id (from ReportingContract)
(define-map verifications
  { report-id: uint }
  {
    status: (string-ascii 20), ;; "pending", "verified", "rejected", "disputed"
    validator-votes: (list 50 principal), ;; List of validators who voted yes
    reject-votes: (list 50 principal), ;; List of validators who voted no
    oracle-data-hash: (optional (buff 32)), ;; Hash of oracle-provided proof
    reduction-percent: uint, ;; Calculated % reduction
    vote-start-block: uint,
    metadata: (string-utf8 1000), ;; Additional notes or evidence
    dispute-id: (optional uint) ;; Link to active dispute if any
  }
)

;; Disputes: Keyed by dispute-id
(define-map disputes
  { dispute-id: uint }
  {
    report-id: uint,
    challenger: principal,
    evidence-hash: (buff 32), ;; Hash of dispute evidence
    resolver-votes: (list 20 principal), ;; Validators voting to uphold dispute
    start-block: uint,
    resolved: bool,
    outcome: (optional bool) ;; true: dispute upheld (report rejected), false: dismissed
  }
)

;; Validator registry: Assumes validators are staked/registered via StakingContract
(define-map validators
  { validator: principal }
  {
    active: bool,
    vote-weight: uint, ;; Based on stake, default 1
    total-votes-cast: uint,
    successful-verifications: uint
  }
)

;; Global configs (governance-updatable)
(define-map configs
  { key: (string-ascii 32) }
  { value: uint }
)

;; Private Functions
(define-private (is-validator (account principal))
  (match (map-get? validators {validator: account})
    entry (get active entry)
    false
  )
)

(define-private (calculate-reduction-percent (baseline uint) (current uint))
  (if (>= current baseline)
    u0
    (/ (* u100 (- baseline current)) baseline)
  )
)

(define-private (get-config (key (string-ascii 32)))
  (default-to u0 (get value (map-get? configs {key: key})))
)

(define-private (tally-votes (report-id uint))
  (let
    (
      (verification (unwrap! (map-get? verifications {report-id: report-id}) (err ERR-INVALID-REPORT)))
      (yes-count (len (get validator-votes verification)))
      (no-count (len (get reject-votes verification)))
      (required-votes (get-config "verification-threshold"))
    )
    {yes: yes-count, no: no-count, required: required-votes}
  )
)

;; Validation Functions
(define-private (validate-report-id (report-id uint))
  (and 
    (> report-id u0)
    (< report-id (get-config "max-report-id"))
  )
)

(define-private (validate-dispute-id (dispute-id uint))
  (and
    (> dispute-id u0)
    (< dispute-id (get-config "dispute-counter"))
  )
)

;; Public Functions
(define-public (register-validator (weight uint))
  (begin
    (asserts! (> weight u0) (err ERR-INVALID-THRESHOLD))
    (asserts! (is-eq tx-sender contract-caller) (err ERR-UNAUTHORIZED)) ;; Assume called from StakingContract
    (map-set validators
      {validator: tx-sender}
      {
        active: true,
        vote-weight: weight,
        total-votes-cast: u0,
        successful-verifications: u0
      }
    )
    (ok true)
  )
)

(define-public (submit-verification-request (report-id uint) (baseline-waste uint) (current-waste uint) (metadata (string-utf8 1000)))
  (begin
    (asserts! (validate-report-id report-id) (err ERR-INVALID-REPORT))
    (asserts! (<= (len metadata) MAX_METADATA_LEN) (err ERR-METADATA-TOO-LONG))
    ;; Assume report exists in ReportingContract; in real impl, use trait to check
    (asserts! (is-none (map-get? verifications {report-id: report-id})) (err ERR-ALREADY-VERIFIED))
    (let
      (
        (reduction (calculate-reduction-percent baseline-waste current-waste))
      )
      (asserts! (>= reduction MIN_REDUCTION_PERCENT) (err ERR-INVALID-CALCULATION))
      (map-set verifications
        {report-id: report-id}
        {
          status: "pending",
          validator-votes: (list),
          reject-votes: (list),
          oracle-data-hash: none,
          reduction-percent: reduction,
          vote-start-block: block-height,
          metadata: metadata,
          dispute-id: none
        }
      )
      (ok true)
    )
  )
)

(define-public (integrate-oracle-data (report-id uint) (data-hash (buff 32)))
  (begin 
    (asserts! (validate-report-id report-id) (err ERR-INVALID-REPORT))
    (let
      (
        (verification (unwrap! (map-get? verifications {report-id: report-id}) (err ERR-INVALID-REPORT)))
      )
      (asserts! (is-eq (get status verification) "pending") (err ERR-INVALID-STATE))
      (asserts! (is-eq tx-sender (as-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.oracle-contract)) (err ERR-UNAUTHORIZED)) ;; Assume oracle principal
      (map-set verifications
        {report-id: report-id}
        (merge verification {oracle-data-hash: (some data-hash)})
      )
      (ok true)
    )
  )
)

(define-public (vote-on-verification (report-id uint) (vote uint))
  (begin
    (asserts! (validate-report-id report-id) (err ERR-INVALID-REPORT))
    (let
      (
        (verification (unwrap! (map-get? verifications {report-id: report-id}) (err ERR-INVALID-REPORT)))
        (is-yes (is-eq vote VOTE_YES))
        (is-no (is-eq vote VOTE_NO))
      )
      (asserts! (or is-yes is-no) (err ERR-INVALID-VOTE))
      (asserts! (is-validator tx-sender) (err ERR-UNAUTHORIZED))
      (asserts! (is-eq (get status verification) "pending") (err ERR-INVALID-STATE))
      (asserts! (< (- block-height (get vote-start-block verification)) DISPUTE_WINDOW) (err ERR-REPORT-EXPIRED))
      (asserts! (not (is-some (index-of (get validator-votes verification) tx-sender))) (err ERR-DUPLICATE-VOTE))
      (asserts! (not (is-some (index-of (get reject-votes verification) tx-sender))) (err ERR-DUPLICATE-VOTE))
      (let
        (
          (updated-votes (if is-yes
                           (unwrap! (as-max-len? (append (get validator-votes verification) tx-sender) u50) (err ERR-INVALID-VOTE))
                           (unwrap! (as-max-len? (append (get reject-votes verification) tx-sender) u50) (err ERR-INVALID-VOTE))))
          (new-verification (if is-yes
                              (merge verification {validator-votes: updated-votes})
                              (merge verification {reject-votes: updated-votes})))
        )
        (map-set verifications {report-id: report-id} new-verification)
        ;; Update validator stats
        (map-set validators {validator: tx-sender}
          (merge (unwrap! (map-get? validators {validator: tx-sender}) (err ERR-UNAUTHORIZED))
            {total-votes-cast: (+ (get total-votes-cast it) u1)}))
        (let ((tallies (tally-votes report-id)))
          (if (>= (get yes tallies) (get required tallies))
            (begin
              (map-set verifications {report-id: report-id} (merge new-verification {status: "verified"}))
              ;; Trigger reward in RewardDistributionContract via post-condition or trait call
              (ok "verified")
            )
            (if (>= (get no tallies) (get required tallies))
              (begin
                (map-set verifications {report-id: report-id} (merge new-verification {status: "rejected"}))
                (ok "rejected")
              )
              (ok "voted")
            )
          )
        )
      )
    )
  )
)

(define-public (initiate-dispute (report-id uint) (evidence-hash (buff 32)))
  (begin
    (asserts! (validate-report-id report-id) (err ERR-INVALID-REPORT))
    (let
      (
        (verification (unwrap! (map-get? verifications {report-id: report-id}) (err ERR-INVALID-REPORT)))
        (dispute-count (default-to u0 (map-get? configs {key: "dispute-counter"})))
        (new-dispute-id (+ dispute-count u1))
      )
      (asserts! (is-eq (get status verification) "verified") (err ERR-INVALID-STATE))
      (asserts! (< (- block-height (get vote-start-block verification)) DISPUTE_WINDOW) (err ERR_DISPUTE-EXPIRED))
      (map-set disputes
        {dispute-id: new-dispute-id}
        {
          report-id: report-id,
          challenger: tx-sender,
          evidence-hash: evidence-hash,
          resolver-votes: (list),
          start-block: block-height,
          resolved: false,
          outcome: none
        }
      )
      (map-set verifications {report-id: report-id} (merge verification {status: "disputed", dispute-id: (some new-dispute-id)}))
      (map-set configs {key: "dispute-counter"} {value: new-dispute-id})
      (ok new-dispute-id)
    )
  )
)

(define-public (vote-on-dispute (dispute-id uint) (uphold bool))
  (begin
    (asserts! (validate-dispute-id dispute-id) (err ERR-DISPUTE-NOT-FOUND))
    (let
      (
        (dispute (unwrap! (map-get? disputes {dispute-id: dispute-id}) (err ERR-DISPUTE-NOT-FOUND)))
        (is-active (not (get resolved dispute)))
      )
      (asserts! is-active (err ERR-INVALID-STATE))
      (asserts! (is-validator tx-sender) (err ERR-UNAUTHORIZED))
      (asserts! (not (is-some (index-of (get resolver-votes dispute) tx-sender))) (err ERR-DUPLICATE-VOTE))
      (let
        (
          (updated-votes (unwrap! (as-max-len? (append (get resolver-votes dispute) tx-sender) u20) (err ERR-INVALID-VOTE)))
          (new-dispute (merge dispute {resolver-votes: updated-votes}))
          (required-votes (get-config "dispute-threshold"))
        )
        (map-set disputes {dispute-id: dispute-id} new-dispute)
        (if (>= (len updated-votes) required-votes)
          (let
            (
              (outcome uphold) ;; Simple majority; in prod, weigh votes
              (final-dispute (merge new-dispute {resolved: true, outcome: (some outcome)}))
              (report-id (get report-id dispute))
              (verification (unwrap! (map-get? verifications {report-id: report-id}) (err ERR-INVALID-REPORT)))
            )
            (map-set disputes {dispute-id: dispute-id} final-dispute)
            (map-set verifications {report-id: report-id}
              (merge verification {status: (if outcome "rejected" "verified"), dispute-id: none}))
            ;; If upheld, slash rewards or penalize via StakingContract
            (ok "resolved")
          )
          (ok "voted")
        )
      )
    )
  )
)

(define-public (update-config (key (string-ascii 32)) (value uint))
  (begin
    (asserts! (is-eq tx-sender (as-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.governance-contract)) (err ERR-UNAUTHORIZED))
    (asserts! (> value u0) (err ERR-INVALID-THRESHOLD))
    (asserts! (is-valid-config-key key) (err ERR-INVALID-CONFIG))
    (map-set configs {key: key} {value: value})
    (ok true)
  )
)

;; Helper Functions
(define-private (is-valid-config-key (key (string-ascii 32)))
  (or 
    (is-eq key "verification-threshold")
    (is-eq key "dispute-threshold")
    (is-eq key "max-report-id")
    (is-eq key "dispute-counter")
  )
)

;; Read-Only Functions
(define-read-only (get-verification-details (report-id uint))
  (map-get? verifications {report-id: report-id})
)

(define-read-only (get-dispute-details (dispute-id uint))
  (map-get? disputes {dispute-id: dispute-id})
)

(define-read-only (get-validator-info (validator principal))
  (map-get? validators {validator: validator})
)

(define-read-only (get-config-value (key (string-ascii 32)))
  (get-config key)
)

(define-read-only (preview-reduction-percent (baseline uint) (current uint))
  (ok (calculate-reduction-percent baseline current))
)

(define-read-only (has-met-threshold (report-id uint))
  (let ((tallies (tally-votes report-id)))
    (>= (get yes tallies) (get required tallies))
  )
)