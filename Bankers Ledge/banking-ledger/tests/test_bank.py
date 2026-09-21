from decimal import Decimal

import pytest

from ledger import (
    AccountNotFoundError,
    Bank,
    CheckingAccount,
    DuplicateAccountError,
    InsufficientFundsError,
    InvalidAccountDataError,
    InvalidAmountError,
    InvalidTransferError,
    LedgerError,
    SavingsAccount,
    TransactionType,
)


def test_bank_requires_valid_name():
    with pytest.raises(InvalidAccountDataError):
        Bank("  ")
    assert Bank("  Acme  ").name == "Acme"


def test_add_and_lookup(bank, savings):
    assert len(bank) == 3
    assert "SAV1" in bank and "NOPE" not in bank
    assert bank.get_account("SAV1") is savings
    assert savings in bank.accounts


def test_duplicate_account_rejected(bank):
    with pytest.raises(DuplicateAccountError) as info:
        bank.add_account(CheckingAccount("SAV1", "Eve"))
    assert info.value.account_id == "SAV1"


def test_only_account_instances_accepted(bank):
    with pytest.raises(InvalidAccountDataError):
        bank.add_account("not an account")


def test_missing_account_raises(bank):
    with pytest.raises(AccountNotFoundError):
        bank.get_account("NOPE")
    with pytest.raises(AccountNotFoundError):
        bank.get_account(["unhashable"])


def test_factory_creates_registered_types(bank):
    acct = bank.create_account("savings", "NEW1", "Dana", initial_deposit="25")
    assert isinstance(acct, SavingsAccount) and bank.get_account("NEW1") is acct


def test_factory_rejects_unknown_type_and_duplicates(bank):
    with pytest.raises(InvalidAccountDataError):
        bank.create_account("hedge_fund", "X1", "Dana")
    with pytest.raises(DuplicateAccountError):
        bank.create_account("savings", "SAV1", "Dana")


def test_transfer_moves_money_and_records_both_sides(bank):
    debit, credit = bank.transfer("CHK1", "SAV1", "150")
    assert bank.get_account("CHK1").balance == Decimal("50.00")
    assert bank.get_account("SAV1").balance == Decimal("1150.00")
    assert debit.kind is TransactionType.TRANSFER_OUT
    assert credit.kind is TransactionType.TRANSFER_IN
    assert "SAV1" in debit.description and "CHK1" in credit.description


def test_transfer_conserves_total_money(bank):
    before = bank.total_holdings()
    bank.transfer("CHK1", "PRM1", "100")
    assert bank.total_holdings() == before


def test_failed_transfer_changes_nothing(bank):
    before = {a.account_id: (a.balance, len(a.transactions)) for a in bank.accounts}
    with pytest.raises(InsufficientFundsError):
        bank.transfer("SAV1", "CHK1", "5000")
    after = {a.account_id: (a.balance, len(a.transactions)) for a in bank.accounts}
    assert before == after


def test_transfer_to_self_rejected(bank):
    with pytest.raises(InvalidTransferError):
        bank.transfer("SAV1", "SAV1", "10")


def test_transfer_with_unknown_account(bank):
    with pytest.raises(AccountNotFoundError):
        bank.transfer("SAV1", "NOPE", "10")
    with pytest.raises(AccountNotFoundError):
        bank.transfer("NOPE", "SAV1", "10")


def test_transfer_invalid_amount_changes_nothing(bank):
    with pytest.raises(InvalidAmountError):
        bank.transfer("SAV1", "CHK1", "-5")
    assert bank.get_account("SAV1").balance == Decimal("1000.00")


def test_all_domain_errors_share_a_base_class(bank):
    for action in (
        lambda: bank.get_account("NOPE"),
        lambda: bank.transfer("SAV1", "SAV1", "1"),
        lambda: bank.get_account("CHK1").withdraw("99999"),
    ):
        with pytest.raises(LedgerError):
            action()


def test_monthly_updates_are_polymorphic(bank):
    results = bank.apply_monthly_updates()
    assert results["SAV1"].kind is TransactionType.INTEREST
    assert results["CHK1"].kind is TransactionType.FEE
    assert results["PRM1"].kind is TransactionType.FEE  # 1000 < 5000 threshold


def test_total_holdings(bank):
    assert bank.total_holdings() == Decimal("2200.00")
    assert Bank().total_holdings() == Decimal("0.00")


def test_bank_round_trip(bank):
    bank.transfer("CHK1", "SAV1", "20")
    bank.apply_monthly_updates()
    clone = Bank.from_dict(bank.to_dict())
    assert clone.name == bank.name
    assert clone.to_dict() == bank.to_dict()


@pytest.mark.parametrize(
    "data",
    [
        [],
        {"version": 99, "accounts": []},
        {"accounts": "nope"},
        {},
    ],
)
def test_bank_from_dict_rejects_bad_documents(data):
    with pytest.raises(InvalidAccountDataError):
        Bank.from_dict(data)


def test_bank_from_dict_rejects_duplicate_ids(bank):
    data = bank.to_dict()
    data["accounts"].append(data["accounts"][0])
    with pytest.raises(DuplicateAccountError):
        Bank.from_dict(data)


def test_repr(bank):
    assert "Test Bank" in repr(bank) and "3" in repr(bank)
