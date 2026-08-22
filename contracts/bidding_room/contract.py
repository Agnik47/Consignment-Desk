import typing

from algopy import (
    ARC4Contract,
    Account,
    Asset,
    Bytes,
    Global,
    Txn,
    UInt64,
    BoxMap,
    gtxn,
    itxn,
    op,
    subroutine,
    urange,
    arc4,
)

# Room lifecycle. Kept as three states at the contract level (not the five the
# backend's rooms.ts models for UI/display) — AGENTS.md's own Phase 6 section
# headings ("Submit sealed bid" / "Close/reveal") only need CREATED -> OPEN ->
# SETTLED here; "bidding closed" and "revealing" are backend-only display
# states with no separate on-chain transition, since reveal and settle happen
# in the same atomic moment per PRD P0-6 ("in one atomic grouped transaction").
# Plain ints, not UInt64(...) — puyapy doesn't allow constructor calls at
# module level; these get wrapped only when assigned inside a method.
STATUS_CREATED = 0
STATUS_OPEN = 1
STATUS_SETTLED = 2


class BidRecord(arc4.Struct):
    commitment: arc4.DynamicBytes
    revealed: arc4.Bool
    guess: arc4.UInt64
    submitted_at: arc4.UInt64


class BiddingRoom(ARC4Contract):
    """
    Sealed-bid, closest-guess-wins escrow for one room, one product.

    "Sealed" here means what AGENTS.md Rule 6 says to be honest about: a
    demo-grade commitment scheme (sha256(guess || nonce)), not research-grade
    bid privacy. Every bidder escrows the SAME fixed stake regardless of their
    guess — the guess itself is what's hidden, not the payment amount, which
    Algorand's public ledger can't hide anyway. See docs/implementation-notes.md.

    This is the authoritative settlement record (AGENTS.md §6) — the backend
    never computes a winner; it only mirrors what this contract determines.
    """

    def __init__(self) -> None:
        self.seller = Account()
        self.treasury = Account()
        self.usdc_asset = Asset()
        self.product_asset = Asset()
        self.bid_stake = UInt64()
        self.fee_bps = UInt64()
        self.target_commitment = Bytes()
        self.deadline = UInt64()
        self.status = UInt64(STATUS_CREATED)
        self.bidder_count = UInt64()
        self.winner = Account()

        # Keyed by bidder address -> their sealed bid.
        self.bids = BoxMap(Account, BidRecord, key_prefix="bid")
        # Insertion-ordered index so settle() can enumerate bidders — BoxMap
        # itself has no native "list all keys" operation on the AVM.
        self.bidder_by_index = BoxMap(UInt64, Account, key_prefix="idx")

    # ---------------------------------------------------------------- setup

    @arc4.abimethod
    def bootstrap(
        self,
        seller: Account,
        treasury: Account,
        usdc_asset: Asset,
        target_commitment: arc4.DynamicBytes,
        bid_stake: arc4.UInt64,
        fee_bps: arc4.UInt64,
        product_name: arc4.String,
    ) -> UInt64:
        """
        One-time setup: opts into USDC, mints the product ASA (1 unit, this
        contract holds it until settlement), and records the room's terms.

        The caller must fund this app's account (a plain Payment, not grouped
        with this call — the app's address doesn't exist to pay until after
        it's created, so there's no way to group a funding payment with the
        very create call that brings the address into existence) with enough
        ALGO to cover: base MBR + one ASA opt-in + one ASA creation, plus
        headroom for settle()'s later inner-transaction fees. Underfunding
        fails loudly here with the AVM's own balance error, not silently.
        """
        assert self.status == STATUS_CREATED, "already bootstrapped"

        self.seller = seller
        self.treasury = treasury
        self.usdc_asset = usdc_asset
        self.bid_stake = bid_stake.native
        self.fee_bps = fee_bps.native
        self.target_commitment = target_commitment.native

        # Opt this app account into USDC so it can hold bid escrow.
        # Inner transactions default to fee=0 (see algopy-stubs — it's a
        # Python-level default, not "let the AVM auto-compute one") and are
        # paid from THIS app's own ALGO balance, not pooled from the caller's
        # transaction unless explicitly arranged — so every one of them needs
        # an explicit real fee, funded by the balance bootstrap's caller
        # sent via fundAppAccount before this call.
        itxn.AssetTransfer(
            xfer_asset=usdc_asset,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=Global.min_txn_fee,
        ).submit()

        created = itxn.AssetConfig(
            total=1,
            decimals=0,
            unit_name="BIDITEM",
            asset_name=product_name.native,
            manager=Global.current_application_address,
            reserve=Global.current_application_address,
            fee=Global.min_txn_fee,
        ).submit()
        self.product_asset = created.created_asset

        return self.product_asset.id

    @arc4.abimethod
    def open_room(self, deadline: arc4.UInt64) -> None:
        assert self.status == STATUS_CREATED, "room already open or settled"
        assert Txn.sender == self.seller, "only the seller can open the room"
        assert deadline.native > Global.latest_timestamp, "deadline must be in the future"
        self.deadline = deadline.native
        self.status = UInt64(STATUS_OPEN)

    # ---------------------------------------------------------------- bid

    @arc4.abimethod
    def commit_bid(self, commitment: arc4.DynamicBytes, stake: gtxn.AssetTransferTransaction) -> None:
        """Locks a fixed stake in escrow against a hidden guess. One per account."""
        assert self.status == STATUS_OPEN, "room is not open for bids"
        assert Global.latest_timestamp <= self.deadline, "bidding deadline has passed"
        assert Txn.sender not in self.bids, "this account has already bid"

        assert stake.asset_receiver == Global.current_application_address, "stake must be paid to this app"
        assert stake.xfer_asset == self.usdc_asset, "stake must be in the room's USDC asset"
        assert stake.sender == Txn.sender, "stake must come from the bidder"
        assert stake.asset_amount == self.bid_stake, "stake does not match the required bid amount"

        self.bidder_by_index[self.bidder_count] = Txn.sender
        self.bidder_count += 1
        self.bids[Txn.sender] = BidRecord(
            commitment=commitment.copy(),
            revealed=arc4.Bool(False),  # noqa: FBT003
            guess=arc4.UInt64(0),
            submitted_at=arc4.UInt64(Global.latest_timestamp),
        )

    @arc4.abimethod
    def reveal_bid(self, bidder: Account, guess: arc4.UInt64, nonce: arc4.DynamicBytes) -> None:
        """
        Verifies a bidder's earlier commitment and records their guess in the
        clear. Callable by anyone (the commitment itself is what's protected)
        once the deadline has passed. In this demo, the operator calls this
        for each bidder, grouped atomically with the following settle() call
        — see docs/implementation-notes.md for why that satisfies PRD P0-6's
        "one atomic grouped transaction" without needing a risky
        dynamic-array-of-structs ABI argument.
        """
        assert self.status == STATUS_OPEN, "room is not in a revealable state"
        assert Global.latest_timestamp > self.deadline, "cannot reveal before the deadline"
        assert bidder in self.bids, "no bid on file for this account"

        record = self.bids[bidder].copy()
        assert not record.revealed.native, "this bid has already been revealed"
        assert _sha256_commitment(guess.native, nonce.native) == record.commitment.native, "guess/nonce does not match the commitment"

        record.revealed = arc4.Bool(True)  # noqa: FBT003
        record.guess = guess
        self.bids[bidder] = record.copy()

    @arc4.abimethod
    def noop(self) -> None:
        """
        Does nothing on purpose — it exists to carry resource references.

        The AVM caps how many accounts/assets/boxes a SINGLE app call may
        reference. settle() touches, per bidder, an account + a bid box + an
        index box, plus seller/treasury/winner and two assets, so it exceeds
        that cap at only ~3 bidders ("No more transactions below reference
        limit"). Grouping extra app calls alongside settle() raises the group's
        combined reference budget without splitting settlement into multiple
        non-atomic steps, which would break PRD P0-6's atomicity requirement.
        """

    # ------------------------------------------------------------- settle

    @arc4.abimethod
    def settle(self, target: arc4.UInt64, target_nonce: arc4.DynamicBytes) -> Account:
        """
        Verifies the room's target commitment, determines the winner among
        revealed bids (closest guess; ties broken by earliest commit time),
        and atomically: pays the winner's stake out as seller proceeds + a
        platform fee to treasury, transfers the product to the winner,
        refunds every other bidder's stake in full, and closes the room.

        Not the authoritative source of "who won" until this call succeeds —
        nothing about the winner is trusted from the backend (AGENTS.md §6).
        """
        assert self.status == STATUS_OPEN, "room is not open"
        assert Global.latest_timestamp > self.deadline, "cannot settle before the deadline"
        assert _sha256_commitment(target.native, target_nonce.native) == self.target_commitment, "target/nonce does not match the room's commitment"

        winner = Account()
        best_distance = UInt64(2**64 - 1)
        best_submitted_at = UInt64(2**64 - 1)
        has_winner = False

        for i in urange(self.bidder_count):
            addr = self.bidder_by_index[i]
            record = self.bids[addr].copy()
            if not record.revealed.native:
                continue
            distance = _abs_diff(record.guess.native, target.native)
            submitted_at = record.submitted_at.native
            is_better = (not has_winner) or (distance < best_distance) or (
                distance == best_distance and submitted_at < best_submitted_at
            )
            if is_better:
                winner = addr
                best_distance = distance
                best_submitted_at = submitted_at
                has_winner = True

        if has_winner:
            fee_amount = (self.bid_stake * self.fee_bps) // UInt64(10_000)
            seller_amount = self.bid_stake - fee_amount

            itxn.AssetTransfer(
                xfer_asset=self.usdc_asset,
                asset_receiver=self.seller,
                asset_amount=seller_amount,
                fee=Global.min_txn_fee,
            ).submit()
            if fee_amount > 0:
                itxn.AssetTransfer(
                    xfer_asset=self.usdc_asset,
                    asset_receiver=self.treasury,
                    asset_amount=fee_amount,
                    fee=Global.min_txn_fee,
                ).submit()
            itxn.AssetTransfer(
                xfer_asset=self.product_asset,
                asset_receiver=winner,
                asset_amount=1,
                fee=Global.min_txn_fee,
            ).submit()
            self.winner = winner
        else:
            # No revealed bids at all — nobody won; the item stays unsold.
            itxn.AssetTransfer(
                xfer_asset=self.product_asset,
                asset_receiver=self.seller,
                asset_amount=1,
                fee=Global.min_txn_fee,
            ).submit()

        for i in urange(self.bidder_count):
            addr = self.bidder_by_index[i]
            if addr == winner and has_winner:
                continue
            itxn.AssetTransfer(
                xfer_asset=self.usdc_asset,
                asset_receiver=addr,
                asset_amount=self.bid_stake,
                fee=Global.min_txn_fee,
            ).submit()

        self.status = UInt64(STATUS_SETTLED)
        return winner


@subroutine
def _sha256_commitment(value: UInt64, nonce: Bytes) -> Bytes:
    return op.sha256(op.itob(value) + nonce)


@subroutine
def _abs_diff(a: UInt64, b: UInt64) -> UInt64:
    if a > b:
        return a - b
    return b - a
