from decimal import Decimal

import pytest

from ledger import (
    Account,
    CheckingAccount,
    InsufficientFundsError,
    InvalidAccountDataError,
    InvalidAmountError,
    PremiumCheckingAccount,
    SavingsAccount,
    TransactionType,
)


# --------------------------------------------------------------------------- #
# Abstraction & construction
# --------------------------------------------------------------------------- #
def test_base_class_cannot_be_instantiated():
    with pytest.raises(TypeError):
        Account("A1", "Alice")


@pytest.mark.parametrize("bad_id", ["", "has space", "a/b", "x" * 33, None, 5, "abc\n"])
def test_invalid_account_id(bad_id):
    with pytest.raises(InvalidAccountDataError):
        SavingsAccount(bad_id, "Alice")


@pytest.mark.parametrize("bad_owner", ["", "   ", None, 42])
def test_invalid_owner(bad_owner):
    with pytest.raises(InvalidAccountDataError):
        CheckingAccount("A1", bad_owner)


def test_owner_is_trimmed():
    assert CheckingAccount("A1", "  Alice  ").owner == "Alice"


def test_initial_deposit_creates_history_entry():
    acct = CheckingAccount("A1", "Alice", "50")
    assert acct.balance == Decimal("50.00")
    assert acct.transactions[0].description == "Initial deposit"


def test_zero_initial_deposit_has_empty_history():
    assert CheckingAccount("A1", "Alice").transactions == ()


def test_negative_initial_deposit_rejected():
    with pytest.raises(InvalidAmountError):
        CheckingAccount("A1", "Alice", "-1")


# --------------------------------------------------------------------------- #
# Encapsulation
# --------------------------------------------------------------------------- #
def test_balance_is_read_only(checking):
    with pytest.raises(AttributeError):
        checking.balance = Decimal("1000000")


def test_transactions_snapshot_cannot_alter_history(checking):
    snapshot = checking.transactions
    assert isinstance(snapshot, tuple)
    checking.deposit("1")
    assert len(snapshot) == 1 and len(checking.transactions) == 2


def test_owner_setter_validates(checking):
    checking.owner = "Carol"
    assert checking.owner == "Carol"
    with pytest.raises(InvalidAccountDataError):
        checking.owner = ""


def test_history_filter(checking):
    checking.deposit("5")
    checking.withdraw("1")
    assert len(checking.history()) == 3
    assert len(checking.history(TransactionType.DEPOSIT)) == 2
    assert len(checking.history(TransactionType.WITHDRAWAL)) == 1


def test_repr_contains_class_and_id(savings):
    text = repr(savings)
    assert "SavingsAccount" in text and "SAV1" in text


# --------------------------------------------------------------------------- #
# Deposits and withdrawals
# --------------------------------------------------------------------------- #
def test_deposit_and_withdraw_update_balance(checking):
    checking.deposit("50.25")
    checking.withdraw("20.25")
    assert checking.balance == Decimal("230.00")


def test_transactions_record_running_balance(checking):
    tx = checking.deposit("10")
    assert tx.balance_after == Decimal("210.00")
    assert tx.kind is TransactionType.DEPOSIT


@pytest.mark.parametrize("bad", ["0", "-10", "abc", None, True, "1.234"])
def test_invalid_amounts_do_not_change_state(checking, bad):
    before = (checking.balance, len(checking.transactions))
    with pytest.raises(InvalidAmountError):
        checking.deposit(bad)
    with pytest.raises(InvalidAmountError):
        checking.withdraw(bad)
    assert (checking.balance, len(checking.transactions)) == before


def test_transfer_helpers_use_distinct_kinds(checking):
    assert checking.transfer_in("5").kind is TransactionType.TRANSFER_IN
    assert checking.transfer_out("5").kind is TransactionType.TRANSFER_OUT


# --------------------------------------------------------------------------- #
# Polymorphism: same call, different rules
# --------------------------------------------------------------------------- #
def test_savings_respects_minimum_balance(savings):
    assert savings.available_funds == Decimal("900.00")
    savings.withdraw("900")
    with pytest.raises(InsufficientFundsError) as info:
        savings.withdraw("0.01")
    assert info.value.account_id == "SAV1"
    assert info.value.available == Decimal("0.00")


def test_savings_available_funds_never_negative():
    acct = SavingsAccount("S", "A", "50", min_balance="100")
    assert acct.available_funds == Decimal("0.00")


def test_checking_allows_overdraft_up_to_limit(checking):
    checking.withdraw("500")  # balance 200 + overdraft 300
    assert checking.balance == Decimal("-300.00")
    with pytest.raises(InsufficientFundsError):
        checking.withdraw("0.01")


def test_insufficient_funds_leaves_state_untouched(checking):
    with pytest.raises(InsufficientFundsError):
        checking.withdraw("501")
    assert checking.balance == Decimal("200.00")


def test_savings_monthly_interest(savings):
    tx = savings.apply_monthly_update()
    assert tx.kind is TransactionType.INTEREST
    assert tx.amount == Decimal("5.00")  # 1000 * 6% / 12
    assert savings.balance == Decimal("1005.00")


def test_interest_rounds_half_up():
    acct = SavingsAccount("S", "A", "100.10", interest_rate="0.06")
    assert acct.apply_monthly_update().amount == Decimal("0.50")  # 0.5005 -> 0.50


def test_no_interest_on_empty_or_tiny_balance():
    assert SavingsAccount("S", "A").apply_monthly_update() is None
    assert SavingsAccount("S", "A", "0.01").apply_monthly_update() is None  # rounds to 0


def test_checking_monthly_fee(checking):
    tx = checking.apply_monthly_update()
    assert tx.kind is TransactionType.FEE
    assert checking.balance == Decimal("190.00")


def test_checking_without_fee_returns_none():
    assert CheckingAccount("C", "A", "10").apply_monthly_update() is None


def test_fee_may_exceed_overdraft_limit():
    acct = CheckingAccount("C", "A", "0", monthly_fee="10")
    acct.apply_monthly_update()
    assert acct.balance == Decimal("-10.00")
    assert acct.available_funds == Decimal("0.00")


def test_premium_is_a_checking_account(premium):
    assert isinstance(premium, CheckingAccount) and isinstance(premium, Account)


def test_premium_fee_waived_above_threshold():
    rich = PremiumCheckingAccount("P", "A", "5000")
    assert rich.apply_monthly_update() is None
    poor = PremiumCheckingAccount("Q", "A", "4999.99")
    assert poor.apply_monthly_update().amount == Decimal("15.00")


def test_premium_defaults_differ_from_checking(premium):
    assert premium.overdraft_limit == Decimal("1000.00")
    assert premium.fee_waiver_threshold == Decimal("5000.00")
    assert premium.monthly_fee == Decimal("15.00")


def test_polymorphic_monthly_update_over_mixed_list(savings, checking, premium):
    kinds = {a.account_id: a.apply_monthly_update().kind for a in (savings, checking, premium)}
    assert kinds == {
        "SAV1": TransactionType.INTEREST,
        "CHK1": TransactionType.FEE,
        "PRM1": TransactionType.FEE,
    }


@pytest.mark.parametrize("rate", ["-0.1", "2", "abc"])
def test_invalid_interest_rate(rate):
    with pytest.raises(InvalidAmountError):
        SavingsAccount("S", "A", interest_rate=rate)


def test_savings_properties(savings):
    assert savings.interest_rate == Decimal("0.06")
    assert savings.min_balance == Decimal("100.00")


# --------------------------------------------------------------------------- #
# Registry & serialisation
# --------------------------------------------------------------------------- #
def test_registry_maps_tags_to_classes():
    assert Account.for_type("savings") is SavingsAccount
    assert Account.for_type("premium_checking") is PremiumCheckingAccount


@pytest.mark.parametrize("bad", ["crypto", None, ["x"]])
def test_unknown_type_rejected(bad):
    with pytest.raises(InvalidAccountDataError):
        Account.for_type(bad)


def test_duplicate_type_tag_rejected():
    with pytest.raises(TypeError):
        class Impostor(Account):  # noqa: F811
            account_type = "savings"


def test_subclass_without_own_tag_is_not_registered():
    before = set(Account._registry)

    class Helper(SavingsAccount):
        pass

    assert set(Account._registry) == before


@pytest.mark.parametrize("fixture_name", ["savings", "checking", "premium"])
def test_round_trip_every_account_type(request, fixture_name):
    original = request.getfixturevalue(fixture_name)
    original.deposit("12.34")
    original.apply_monthly_update()
    clone = Account.from_dict(original.to_dict())
    assert type(clone) is type(original)
    assert clone.balance == original.balance
    assert clone.transactions == original.transactions
    assert clone.to_dict() == original.to_dict()


def test_from_dict_requires_mapping():
    with pytest.raises(InvalidAccountDataError):
        Account.from_dict([])


def test_from_dict_reports_missing_fields(savings):
    data = savings.to_dict()
    del data["owner"]
    with pytest.raises(InvalidAccountDataError, match="owner"):
        Account.from_dict(data)


def test_from_dict_rejects_unknown_params(savings):
    data = savings.to_dict()
    data["params"]["surprise"] = "1"
    with pytest.raises(InvalidAccountDataError, match="parameters"):
        Account.from_dict(data)


def test_from_dict_rejects_wrong_container_types(savings):
    data = savings.to_dict()
    data["transactions"] = "nope"
    with pytest.raises(InvalidAccountDataError):
        Account.from_dict(data)


def test_from_dict_detects_tampered_balance(savings):
    data = savings.to_dict()
    data["balance"] = "999999.00"
    with pytest.raises(InvalidAccountDataError, match="does not match"):
        Account.from_dict(data)


def test_from_dict_rejects_nonzero_balance_without_history():
    data = SavingsAccount("S", "A").to_dict()
    data["balance"] = "5.00"
    with pytest.raises(InvalidAccountDataError):
        Account.from_dict(data)


def test_default_params_hook_is_empty():
    """A minimal untagged subclass inherits the base ``_params`` (no extras)."""

    class Minimal(Account):
        @property
        def available_funds(self):
            return self.balance

        def apply_monthly_update(self):
            return None

    acct = Minimal("M1", "Zed", "5")
    assert acct.to_dict()["params"] == {}
    assert "Minimal" not in {c.__name__ for c in Account._registry.values()}
